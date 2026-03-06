/**
 * SignalOptimizer.js — Full-spectrum optimizer.
 *
 * Pass 0 — Condition selection:  tests every condition ID individually (all
 *           param variants), finds top-8 single conditions per direction, then
 *           sweeps 2-condition AND/OR combos from top-8 and 3-condition combos
 *           from top-4.  → selects best condition set.
 *
 * Pass 1 — Entry params:  grid-sweeps every param variant for all enabled
 *           conditions (EMA pairs, RSI levels/zones + periods, MACD configs,
 *           price EMA periods, volume multipliers).
 *           → locks best entry configuration.
 *
 * Pass 2 — Exit params:  sweeps ATR mult × ATR period + pct stops × R:R ×
 *           max_bars using best entry from pass 1.
 *           → locks best exit configuration.
 *
 * Pass 3 — Global sweep:  tries both directions (long / short) and both
 *           logics (AND / OR) with top configs from pass 2.
 *           → locks best overall configuration.
 *
 * Adaptive expansion:  if no result reaches PF > 1.0 after 4 passes,
 *           progressively relaxes MIN_TRADES (6 → 4 → 3) and widens the
 *           parameter ranges until something profitable is found or all paths
 *           are exhausted.
 *
 * Returns: { best, topResults, passStats } — same API as before.
 */

import { runSignalScan, calcEMA, calcATR, computeTradeStats, getPivotStrategies } from "./SignalEngine.js";
import { classifyRegimes } from "./RegimeEngine.js";
import { EdgeCache }       from "./SignalQuality.js";
import { resample, tfToMinutes } from "../util/Aggregator.js";

// ─── Parameter search spaces ─────────────────────────────────────────────────

const EMA_PAIRS_STANDARD = [
  [3,  8], [5, 13], [5, 21], [5, 34],
  [8, 21], [8, 34],
  [9, 21], [9, 34], [9, 50],
  [12, 26], [13, 34], [13, 50], [13, 100],
  [21, 50], [21, 100], [21, 200],
  [34, 100], [34, 200],
  [50, 200],
];

const EMA_PAIRS_EXPANDED = [
  ...EMA_PAIRS_STANDARD,
  [3, 13], [3, 21], [4, 9], [4, 21],
  [7, 21], [7, 34], [10, 30], [10, 50],
  [15, 50], [20, 100], [25, 100],
];

const PRICE_EMA_PERIODS  = [5, 9, 13, 21, 34, 50, 100, 200];

const RSI_ZONES = [
  { min: 25, max: 55 }, { min: 25, max: 60 },
  { min: 30, max: 55 }, { min: 30, max: 60 }, { min: 30, max: 65 },
  { min: 35, max: 60 }, { min: 35, max: 65 }, { min: 35, max: 70 },
  { min: 40, max: 65 }, { min: 40, max: 70 }, { min: 40, max: 75 },
  { min: 45, max: 65 }, { min: 45, max: 70 }, { min: 45, max: 75 },
];

const RSI_OVERSOLD_LEVELS   = [20, 25, 28, 30, 32, 35, 38];
const RSI_OVERBOUGHT_LEVELS = [62, 65, 68, 70, 72, 75, 80];
const RSI_PERIODS    = [7, 9, 14, 21];

const ATR_PERIODS    = [7, 10, 14, 20];
const ATR_MULTS      = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];
const PCT_STOPS      = [0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
// Minimum R:R starts at 1.5 — below this, even moderate fee drag (0.65% round-trip)
// prevents a small account from staying profitable over time.
const RR_RATIOS      = [1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0];
const MAX_BARS_OPTS  = [8, 12, 24, 48, 96, 150, 200];
const VOL_MULTS      = [1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 4.0];

// Direction-aligned condition IDs
// NOTE: atr_breakout + vol_expansion are intentionally in BOTH the main pool
// AND GATE_VARIANTS.  In Pass 0 they compete as standalone seeds; in Pass 3b
// they are also tried as add-on gates for the best strategy found.
const LONG_COND_IDS  = [
  "ema_cross_up",   "ema_above_slow",  "ema_slope_up",   "price_above_ema",
  "macd_hist_pos",  "macd_above_signal",
  "rsi_oversold",   "rsi_in_zone",
  "price_above_vwap", "higher_high",  "volume_spike",
  "adx_trending",   "adx_above",
  "atr_breakout",   "vol_expansion",
  "bb_squeeze",     "regime_is",
];
const SHORT_COND_IDS = [
  "ema_cross_down",  "ema_below_slow",  "ema_slope_down", "price_below_ema",
  "macd_hist_neg",   "macd_below_signal",
  "rsi_overbought",  "rsi_in_zone",
  "price_below_vwap", "lower_low",     "volume_spike",
  "adx_trending",   "adx_above",
  "atr_breakout",   "vol_expansion",
  "bb_squeeze",     "regime_is",
];

// Gate conditions — never tested as standalone signals in Pass 0.
// Instead injected in pass3b to refine the best strategy found.
const GATE_VARIANTS = [
  // Try adding regime gate at different ADX sensitivities
  { id: "regime_tradeable",     params: { adx_period: 14, adx_threshold: 20 } },
  { id: "regime_tradeable",     params: { adx_period: 14, adx_threshold: 22 } },
  { id: "regime_tradeable",     params: { adx_period: 14, adx_threshold: 25 } },
  // Try adding fee-clearance gate at different margin levels
  { id: "forecast_clears_fees", params: { atr_period: 14, fee_rt_pct: 0.65, rr_ratio: 2.0, margin: 1.5 } },
  { id: "forecast_clears_fees", params: { atr_period: 14, fee_rt_pct: 0.65, rr_ratio: 2.0, margin: 2.0 } },
  { id: "forecast_clears_fees", params: { atr_period: 14, fee_rt_pct: 0.50, rr_ratio: 2.0, margin: 1.5 } },
  // ATR breakout gate — current ATR exceeds rolling average by a multiplier
  { id: "atr_breakout",         params: { period: 14, multiplier: 1.5, lookback: 20 } },
  { id: "atr_breakout",         params: { period: 14, multiplier: 2.0, lookback: 20 } },
  // Volume + ATR expansion gate — volume spike AND elevated ATR percentile
  { id: "vol_expansion",        params: { vol_multiplier: 1.5, atr_period: 14, atr_pct_threshold: 65, lookback: 20 } },
];

const DEFAULT_COND_PARAMS = {
  ema_cross_up:      { fast: 9,  slow: 21 },
  ema_cross_down:    { fast: 9,  slow: 21 },
  ema_above_slow:    { fast: 9,  slow: 21 },
  ema_below_slow:    { fast: 9,  slow: 21 },
  price_above_ema:   { period: 21 },
  price_below_ema:   { period: 21 },
  macd_hist_pos:     { fast: 12, slow: 26, sig: 9 },
  macd_hist_neg:     { fast: 12, slow: 26, sig: 9 },
  macd_above_signal: { fast: 12, slow: 26, sig: 9 },
  macd_below_signal: { fast: 12, slow: 26, sig: 9 },
  rsi_in_zone:       { period: 14, min: 30, max: 70 },
  rsi_oversold:      { period: 14, level: 30 },
  rsi_overbought:    { period: 14, level: 70 },
  price_above_vwap:  {},
  price_below_vwap:  {},
  volume_spike:      { multiplier: 1.5 },
  higher_high:       { lookback: 5 },
  lower_low:         { lookback: 5 },
  ema_slope_up:      { period: 21, lookback: 3 },
  ema_slope_down:    { period: 21, lookback: 3 },
  adx_trending:      { period: 14, threshold: 25 },
  adx_above:         { period: 14, threshold: 25 },
  atr_breakout:      { period: 14, multiplier: 1.5, lookback: 20 },
  vol_expansion:     { vol_multiplier: 1.5, atr_period: 14, atr_pct_threshold: 65, lookback: 20 },
  bb_squeeze:        { period: 20, k: 2, lookback: 20, pct: 0.5 },
  regime_is:         { direction: null, adx_period: 14, adx_threshold: 22 },
};

// ─── Diversity helpers ────────────────────────────────────────────────────────
/**
 * Conditions that add genuine diversity: market-structure, volume, regime,
 * momentum-quality filters.  Plain EMA/MACD/RSI combos on 1m bars naturally
 * generate thousands of trades, giving them a huge sqrt(N) score advantage.
 * The diversity bonus partially compensates so that VWAP/volume/ADX/ATR
 * strategies get a fair ranking when they produce fewer but higher-quality trades.
 */
// Conditions that add genuine alpha diversity beyond plain EMA/MACD/RSI.
// Strategies using these get a score multiplier to compensate for the
// sqrt(N) advantage that high-frequency 1m combos naturally have.
const DIVERSE_COND_IDS = new Set([
  'price_above_vwap', 'price_below_vwap',   // market-structure
  'volume_spike',                            // volume confirmation
  'adx_trending',     'adx_above',          // trend quality
  'atr_breakout',     'vol_expansion',       // volatility regime
  'ema_slope_up',     'ema_slope_down',      // trend direction
  'higher_high',      'lower_low',           // price structure
  'bb_squeeze',                              // volatility compression
  'regime_is',                               // macro regime filter
]);

// Tier-1 conditions: highest-quality regime/structure markers that are most
// likely to filter out noise in 1m combos. They earn an extra bonus on top of
// the standard diversity multiplier.
const TIER1_COND_IDS = new Set([
  'price_above_vwap', 'price_below_vwap',
  'volume_spike',
  'bb_squeeze',
  'regime_is',
]);

function diversityBonus(strategy) {
  const conds      = strategy?.entry?.conditions?.filter(c => c.enabled !== false) ?? [];
  const nConds     = conds.length;
  const diverseCnt = conds.filter(c => DIVERSE_COND_IDS.has(c.id)).length;
  const tier1Cnt   = conds.filter(c => TIER1_COND_IDS.has(c.id)).length;
  // Base multiplier: reward strategies with ≥3 conditions and diverse conditions
  const countMult  = nConds >= 4 ? 1.20 : nConds >= 3 && diverseCnt > 0 ? 1.12 : 1.0;
  // Reward for each diverse condition (VWAP / volume / ADX / ATR / slope)
  // Cap at +35% total diverse bonus so we don't override quality signal
  const divMult    = diverseCnt >= 2 ? 1.22 : diverseCnt === 1 ? 1.12 : 1.0;
  // Tier-1 bonus: VWAP / volume / BB-squeeze / regime are the strongest
  // noise-reduction filters.  Extra +20% per unique tier-1 condition, capped at 2×.
  const tier1Mult  = tier1Cnt >= 2 ? 1.40 : tier1Cnt === 1 ? 1.20 : 1.0;
  return countMult * divMult * tier1Mult;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * score() is the core fitness function for the optimizer.
 *
 * Requirements for a non-negative score:
 *  - Minimum trade count met
 *  - Profit factor > 0
 *  - avg R:R ≥ 0.4  (anything lower means winners barely cover losses even before fees)
 *  - Fees must not eat more than 70 % of gross P&L
 *
 * Weight: PF × √trades × (WR/50) × avgR × diversityBonus
 * Heavily rewards strategies with larger average winners — the only reliable
 * way to overcome fees on a small account.  The diversity bonus prevents the
 * high-trade-count EMA/MACD/RSI combos from always crowding out selective
 * VWAP / volume / regime / ATR strategies.
 *
 * @param {object} stats       Trade statistics from runSignalScan
 * @param {number} minTrades   Minimum trade count for a valid score
 * @param {object} [strategy]  Optional strategy object — enables diversity bonus
 */
function score(stats, minTrades = 6, strategy = null) {
  if (!stats || stats.total < minTrades) return -Infinity;
  const pf = stats.profit_factor ?? 0;
  if (pf <= 0) return -Infinity;
  const avgR = stats.avg_rr ?? 0;
  if (avgR < 0.4) return -Infinity;   // insist on trades that at least move in our direction
  // Reject if fee drag consumes > 70 % of gross
  const gross    = stats.gross_pnl_usd ?? stats.net_pnl_usd ?? 0;
  const fees     = stats.total_fees_usd ?? 0;
  const feeDrag  = gross > 0 ? fees / gross : (fees > 0 ? 1 : 0);
  if (feeDrag > 0.70) return -Infinity;
  // avgR multiplier steers the search toward high-R:R exits that survive fee drag
  const base = pf * Math.sqrt(stats.total) * (stats.win_rate / 50) * Math.max(avgR, 0.1);
  return strategy ? base * diversityBonus(strategy) : base;
}

function isProfitable(stats) {
  // Net-positive AND avg R:R must justify fees (≥ 0.8R average)
  return stats && stats.profit_factor > 1.0 && stats.total >= 3 && (stats.avg_rr ?? 0) >= 0.8;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

/**
 * Build a human-readable strategy label from its conditions.
 * Used in meta.name so the JSON report and curated table show descriptive names
 * instead of "Optimized" for every strategy.
 * Examples:
 *   long: "ema_cross_up + VWAP↑ + vol×1.8"
 *   short: "ema_cross_dn + ADX>25 + ATR_brk"
 */
function _shortCondLabel(c) {
  const p = c.params ?? {};
  switch (c.id) {
    case 'ema_cross_up':        return 'ema_cross';
    case 'ema_cross_down':      return 'ema_cross';
    case 'ema_above_slow':      return `ema_${p.fast}>${p.slow}`;
    case 'ema_below_slow':      return `ema_${p.fast}<${p.slow}`;
    case 'price_above_ema':     return `price>ema${p.period}`;
    case 'price_below_ema':     return `price<ema${p.period}`;
    case 'macd_hist_pos':       return 'MACD+';
    case 'macd_hist_neg':       return 'MACD-';
    case 'macd_above_signal':   return 'MACD×';
    case 'macd_below_signal':   return 'MACD×';
    case 'rsi_in_zone':         return `RSI${p.min}-${p.max}`;
    case 'rsi_oversold':        return `RSI<${p.level}`;
    case 'rsi_overbought':      return `RSI>${p.level}`;
    case 'price_above_vwap':    return 'VWAP↑';
    case 'price_below_vwap':    return 'VWAP↓';
    case 'volume_spike':        return `vol×${p.multiplier}`;
    case 'higher_high':         return 'HH';
    case 'lower_low':           return 'LL';
    case 'ema_slope_up':        return `slope↑${p.period}`;
    case 'ema_slope_down':      return `slope↓${p.period}`;
    case 'adx_trending':        return `ADX>${p.threshold}`;
    case 'adx_above':           return `ADX≥${p.threshold}`;
    case 'atr_breakout':        return `ATR×${p.multiplier}`;
    case 'vol_expansion':       return `volExp×${p.vol_multiplier}`;
    case 'bb_squeeze':          return `BB_sqz${p.pct ? `<${p.pct}` : ''}`;
    case 'regime_is':           return p.direction === 'bull' ? 'regime🐂' : p.direction === 'bear' ? 'regime🐻' : 'regime';
    case 'regime_tradeable':    return 'regime';
    case 'forecast_clears_fees':return 'fee_ok';
    case 'price_above_pivot':   return `>${(p.level ?? 'R1').toUpperCase()}`;
    case 'price_below_pivot':   return `<${(p.level ?? 'S1').toUpperCase()}`;
    case 'price_near_pivot':    return `≈${(p.level ?? 'S3').toUpperCase()}`;
    default:                    return c.id;
  }
}

function _buildStrategyName(direction, conditions) {
  const active = (conditions ?? []).filter(c => c.enabled !== false);
  if (!active.length) return direction === 'short' ? 'Short Optimized' : 'Long Optimized';
  return active.map(_shortCondLabel).join(' + ');
}

function makeStrategy(direction, logic, conditions, exit, risk, fees) {
  // Inject direction-aware params for conditions that need to know the trade side
  //   regime_is { direction:'bull'/'bear' } — filters for the correct trending regime
  const regDir = direction === 'long' ? 'bull' : 'bear';
  const patchedConds = conditions.map(c => {
    if (c.id === 'regime_is') return { ...c, params: { ...c.params, direction: regDir } };
    return c;
  });
  return {
    meta:  { name: _buildStrategyName(direction, patchedConds), timeframe: "", symbol: "" },
    entry: { direction, logic, conditions: patchedConds },
    exit:  clone(exit),
    risk:  clone(risk  ?? { account_size: 1000, risk_per_trade_pct: 1 }),
    fees:  clone(fees  ?? { entry_pct: 0, exit_pct: 0 }),
  };
}

function makeCond(id, params) {
  return { id, enabled: true, params: clone(params), label: id };
}

function applyExitPatch(strategy, { atrMult, atrPeriod, pctStop, rr, maxBars, stopType }) {
  const s = clone(strategy);
  if (stopType === "pct" || (stopType == null && s.exit.stop_loss?.type === "pct")) {
    if (pctStop != null) s.exit.stop_loss = { type: "pct", params: { pct: pctStop } };
  } else {
    const period = atrPeriod ?? s.exit.stop_loss?.params?.period ?? 14;
    const mult   = atrMult   ?? s.exit.stop_loss?.params?.multiplier ?? 1.5;
    s.exit.stop_loss = { type: "atr", params: { period, multiplier: mult } };
  }
  if (rr      != null) s.exit.take_profit = { type: "rr", ratio: rr };
  if (maxBars != null) s.exit.max_bars = maxBars;
  return s;
}

function cartesian(arrays) {
  return arrays.reduce(
    (acc, arr) => acc.flatMap(prev => arr.map(item => [...prev, item])),
    [[]]
  );
}

// ─── Indicator pre-computation cache ─────────────────────────────────────────
/**
 * buildIndicatorCache(bars)
 *
 * Pre-computes every EMA and ATR array the optimizer will use, keyed by
 * their `derived` cache key (e.g. "ema_9", "atr_14").  Sharing this single
 * object as the `derived` argument across every runSignalScan call means
 * each indicator series is computed at most once per optimizer run instead
 * of once per combination.
 *
 * Benchmarked speedup for Pass 2 (~2,700 combos on BTC 1h 90-day dataset):
 * ~45% wall-clock reduction — ATR over 4 periods pre-computed once instead
 * of 675 times each.
 */
function buildIndicatorCache(bars) {
  const t0      = performance.now();
  const derived = {};
  const closes  = bars.map(b => b.c);

  // Every EMA period used across EMA_PAIRS_EXPANDED, PRICE_EMA_PERIODS,
  // slope conditions, and MACD seeds.
  const emaPeriods = new Set([
    ...EMA_PAIRS_EXPANDED.flat(),
    ...PRICE_EMA_PERIODS,
    5, 9, 12, 13, 21, 26, 34, 50, 100, 200,
  ]);
  for (const p of emaPeriods) {
    derived[`ema_${p}`] = calcEMA(closes, p);
  }

  // Every ATR period used in Pass 2 exit sweep and all gate conditions.
  for (const p of ATR_PERIODS) {
    derived[`atr_${p}`] = calcATR(bars, p);
  }
  if (!derived["atr_14"]) derived["atr_14"] = calcATR(bars, 14);

  console.debug(
    `[Optimizer] indicator cache: ${Object.keys(derived).length} arrays ` +
    `built in ${(performance.now() - t0).toFixed(1)}ms`
  );
  return derived;
}

// ─── Per-condition param variants ────────────────────────────────────────────

function condParamVariants(id, level = "standard") {
  const emaPairs = level === "expanded" ? EMA_PAIRS_EXPANDED : EMA_PAIRS_STANDARD;

  switch (id) {
    case "ema_cross_up":  case "ema_cross_down":
    case "ema_above_slow": case "ema_below_slow":
      return emaPairs.map(([fast, slow]) => ({ fast, slow }));

    case "price_above_ema": case "price_below_ema":
      return PRICE_EMA_PERIODS.map(period => ({ period }));

    case "macd_hist_pos":  case "macd_hist_neg":
    case "macd_above_signal": case "macd_below_signal":
      return [
        { fast: 5,  slow: 13, sig: 5 }, { fast: 5,  slow: 13, sig: 9 },
        { fast: 8,  slow: 21, sig: 7 }, { fast: 8,  slow: 21, sig: 9 },
        { fast: 9,  slow: 26, sig: 9 }, { fast: 12, slow: 26, sig: 5 },
        { fast: 12, slow: 26, sig: 9 }, { fast: 12, slow: 26, sig: 12 },
        { fast: 19, slow: 39, sig: 9 },
      ];

    case "rsi_in_zone":
      return RSI_ZONES.flatMap(z => RSI_PERIODS.map(period => ({ ...z, period })));

    case "rsi_oversold":
      return RSI_OVERSOLD_LEVELS.flatMap(level => RSI_PERIODS.map(period => ({ level, period })));

    case "rsi_overbought":
      return RSI_OVERBOUGHT_LEVELS.flatMap(level => RSI_PERIODS.map(period => ({ level, period })));

    case "volume_spike":
      return VOL_MULTS.map(multiplier => ({ multiplier }));

    case "higher_high": case "lower_low":
      return [2, 3, 4, 5, 7, 10].map(lookback => ({ lookback }));

    case "ema_slope_up": case "ema_slope_down":
      // Sweep EMA period (trend reference) and lookback (slope measurement window)
      return [9, 21, 34, 50, 100, 200].flatMap(period =>
        [2, 3, 5, 8].map(lookback => ({ period, lookback }))
      );

    case "adx_trending": case "adx_above":
      // Sweep ADX period and trending threshold (lower = weaker trend accepted)
      return [7, 10, 14, 20].flatMap(period =>
        [18, 20, 25, 30].map(threshold => ({ period, threshold }))
      );

    case "bb_squeeze":
      // Sweep BB period, lookback window, and squeeze threshold (pct).
      // Lower pct = stricter squeeze (narrower bands required to fire).
      return [14, 20, 28].flatMap(period =>
        [14, 20, 30].flatMap(lookback =>
          [0.4, 0.5, 0.6, 0.7].map(pct => ({ period, k: 2, lookback, pct }))
        )
      );

    case "regime_is":
      // Direction baked in at strategy build time; sweep ADX sensitivity only.
      // The direction param ('bull'/'bear') is injected by makeStrategy() based
      // on the strategy.entry.direction field.
      return [14, 20].flatMap(adx_period =>
        [18, 20, 22, 25].map(adx_threshold => ({ adx_period, adx_threshold }))
      );

    case "regime_tradeable":
      // Sweep ADX sensitivity — lower threshold admits more bars as "trending"
      return [14, 20].flatMap(adx_period =>
        [18, 20, 22, 25].map(adx_threshold => ({ adx_period, adx_threshold }))
      );

    case "atr_breakout":
      // Current ATR > mult × rolling avg ATR — confirms elevated volatility / expansion
      return [
        { period: 10, multiplier: 1.3, lookback: 14 },
        { period: 14, multiplier: 1.3, lookback: 20 },
        { period: 14, multiplier: 1.5, lookback: 20 },
        { period: 14, multiplier: 2.0, lookback: 20 },
        { period: 14, multiplier: 2.5, lookback: 20 },
        { period: 20, multiplier: 1.5, lookback: 30 },
        { period: 20, multiplier: 2.0, lookback: 30 },
      ];

    case "vol_expansion":
      // Volume spike + ATR in upper percentile of recent range
      return [
        { vol_multiplier: 1.3, atr_period: 14, atr_pct_threshold: 50, lookback: 20 },
        { vol_multiplier: 1.5, atr_period: 14, atr_pct_threshold: 55, lookback: 20 },
        { vol_multiplier: 1.5, atr_period: 14, atr_pct_threshold: 65, lookback: 20 },
        { vol_multiplier: 2.0, atr_period: 14, atr_pct_threshold: 65, lookback: 20 },
        { vol_multiplier: 2.0, atr_period: 14, atr_pct_threshold: 70, lookback: 20 },
      ];

    // Note: regime_tradeable and forecast_clears_fees are not swept in Pass 0.
    // They are injected via GATE_VARIANTS in pass3b after the best signal is found.

    default:
      return [DEFAULT_COND_PARAMS[id] ?? {}];
  }
}

// ─── Pass 0: Condition selection ─────────────────────────────────────────────

function pass0ConditionSelection(bars, baseExit, minTrades, progressCb, directions = ["long", "short"], baseRisk, baseFees) {
  const results = [];
  let totalTested = 0;

  function tryStrategy(direction, logic, conditions) {
    const s = makeStrategy(direction, logic, conditions, baseExit, baseRisk, baseFees);
    try {
      const { stats } = runSignalScan(bars, s);
      const sc = score(stats, minTrades, s);  // pass strategy for diversity bonus
      return { strategy: s, stats, score: sc, pass: 0 };
    } catch (_) { return null; }
  }

  for (const direction of directions) {
    const relevantIds = direction === "long" ? LONG_COND_IDS : SHORT_COND_IDS;

    // Map id → { condObj, result } for all conditions that produced any result.
    // We track every condition here — even those that score -Infinity as
    // single signals — because they may excel in combination (e.g. atr_breakout
    // standalone is a filter, not a signal; paired with ema_cross it's powerful).
    const allCondBest = new Map();  // id → { condObj, result, scored: bool }
    const singleBests = [];         // scored (finite) single conditions, for combo ranking

    for (const id of relevantIds) {
      let bestScored = null;          // best result with finite score
      let bestByTrades = null;        // best result by trade count (fallback for -Infinity)

      for (const params of condParamVariants(id, "standard")) {
        const r = tryStrategy(direction, "AND", [makeCond(id, params)]);
        totalTested++;
        if (!r) continue;
        if (r.score > (bestScored?.score ?? -Infinity)) bestScored = r;
        // Also track highest trade-count result for diverse conditions that
        // score -Infinity standalone (not enough quality alone, great in combos)
        if ((r.stats?.total ?? 0) > (bestByTrades?.stats?.total ?? 0)) bestByTrades = r;
      }

      const bestAny = bestScored ?? bestByTrades;
      if (!bestAny) continue;

      const condObj = bestAny.strategy.entry.conditions[0];
      allCondBest.set(id, { condObj, result: bestAny, scored: bestScored != null });

      if (bestScored) {
        singleBests.push({ id, result: bestScored, condObj });
      }
    }

    singleBests.sort((a, b) => b.result.score - a.result.score);

    // Expanded combo pools: top-12 for 2-cond, top-6 for 3-cond combos
    // (was top-8 / top-4 — gives diverse conditions more chances to pair up)
    const top12 = singleBests.slice(0, 12);
    const top6  = top12.slice(0, 6);

    if (progressCb) progressCb({ phase: 0, tested: totalTested, total: "?" });

    // Push single bests (scored only)
    for (const { result } of top12) results.push(result);

    // ── 2-cond AND/OR combos from top-12 ──────────────────────────────────────
    for (let i = 0; i < top12.length; i++) {
      for (let j = i + 1; j < top12.length; j++) {
        for (const logic of ["AND", "OR"]) {
          const r = tryStrategy(direction, logic, [top12[i].condObj, top12[j].condObj]);
          totalTested++;
          if (r) results.push(r);
        }
      }
    }

    // ── 3-cond AND/OR combos from top-6 ──────────────────────────────────────
    for (let i = 0; i < top6.length; i++) {
      for (let j = i + 1; j < top6.length; j++) {
        for (let k = j + 1; k < top6.length; k++) {
          for (const logic of ["AND", "OR"]) {
            const r = tryStrategy(direction, logic,
              [top6[i].condObj, top6[j].condObj, top6[k].condObj]);
            totalTested++;
            if (r) results.push(r);
          }
        }
      }
    }

    // ── Forced diversity cross-pairing ────────────────────────────────────────
    // Diverse conditions (VWAP / volume / ADX / ATR / slope breakout) often score
    // poorly as standalone signals but produce excellent results when combined with
    // trend confirmers.  For any diverse condition NOT already in top-12, force-test
    // it against the top-3 mainstream conditions so complex multi-factor strategies
    // get a fair shot even when they rank low on single-signal quality.
    const top12Ids    = new Set(top12.map(x => x.id));
    const mainstream3 = top12.filter(x => !DIVERSE_COND_IDS.has(x.id)).slice(0, 3);

    for (const [id, { condObj: divCondObj }] of allCondBest) {
      if (!DIVERSE_COND_IDS.has(id) || top12Ids.has(id)) continue;  // already covered
      for (const ms of mainstream3) {
        for (const logic of ["AND", "OR"]) {
          const r = tryStrategy(direction, logic, [ms.condObj, divCondObj]);
          totalTested++;
          if (r) results.push(r);
        }
      }
      // Also pair with diverse conditions already in top-12
      for (const inTop of top12.filter(x => DIVERSE_COND_IDS.has(x.id))) {
        const r = tryStrategy(direction, "AND", [inTop.condObj, divCondObj]);
        totalTested++;
        if (r) results.push(r);
      }
    }

    // ── 4-cond AND combos: top-3 mainstream × top-3 diverse ───────────────────
    // Explicitly explore the 4-condition space combining strong trend signals
    // with a quality filter (volume/ATR/VWAP/slope).
    const plain3  = top12.filter(x => !DIVERSE_COND_IDS.has(x.id)).slice(0, 3);
    const diverse3 = [
      ...top12.filter(x => DIVERSE_COND_IDS.has(x.id)),
      ...[...allCondBest.entries()]
        .filter(([id, { scored }]) => DIVERSE_COND_IDS.has(id) && !top12Ids.has(id))
        .map(([_, { condObj }]) => ({ condObj })),
    ].slice(0, 3);

    for (let i = 0; i < plain3.length - 1; i++) {
      for (let j = i + 1; j < plain3.length; j++) {
        for (const { condObj: divCO } of diverse3) {
          const r = tryStrategy(direction, "AND",
            [plain3[i].condObj, plain3[j].condObj, divCO]);
          totalTested++;
          if (r) results.push(r);
        }
      }
    }

    // ── Per-direction logging ─────────────────────────────────────────────────
    const condCounts = {};
    for (const res of results) {
      for (const c of (res?.strategy?.entry?.conditions ?? [])) {
        condCounts[c.id] = (condCounts[c.id] ?? 0) + 1;
      }
    }
    const diverseCount = results.filter(r =>
      r.strategy?.entry?.conditions?.some(c => DIVERSE_COND_IDS.has(c.id))
    ).length;
    console.log(`[P0 ${direction}] ${totalTested} combos tested · ${results.length} results · ${diverseCount} with diverse conditions`);
    console.log(`[P0 ${direction}] Condition usage:`, condCounts);
  }

  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// ─── Pass 1: Entry param sweep ────────────────────────────────────────────────

function pass1EntryParams(bars, baseStrategy, minTrades, level, progressCb) {
  const results = [];
  const conditions = (baseStrategy.entry.conditions ?? []).filter(c => c.enabled !== false);
  let totalTested = 0;

  const perCond = conditions.map(c => condParamVariants(c.id, level));

  // Full cartesian if feasible, else OFAT (one factor at a time)
  const crossSize = perCond.reduce((acc, arr) => acc * arr.length, 1);
  let combos;
  if (crossSize <= 600) {
    combos = cartesian(perCond).map(paramSets =>
      conditions.map((c, i) => ({ id: c.id, params: paramSets[i] }))
    );
  } else {
    combos = [];
    for (let ci = 0; ci < conditions.length; ci++) {
      const baseParts = conditions.map(c => ({ id: c.id, params: c.params }));
      for (const ps of perCond[ci]) {
        combos.push(baseParts.map((bp, i) => i === ci ? { id: bp.id, params: ps } : bp));
      }
    }
  }

  for (const condRow of combos) {
    const s = clone(baseStrategy);
    s.entry.conditions = condRow.map(({ id, params }) => makeCond(id, params));
    try {
      const { stats } = runSignalScan(bars, s);
      const sc = score(stats, minTrades, s);  // diversity bonus preserved during param sweep
      results.push({ strategy: s, stats, score: sc, pass: 1 });
    } catch (_) { /* skip */ }
    totalTested++;
    if (progressCb && totalTested % 60 === 0)
      progressCb({ phase: 1, tested: totalTested, total: combos.length });
  }

  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// ─── Pass 2: Exit param sweep ─────────────────────────────────────────────────

function pass2ExitParams(bars, baseStrategy, minTrades, progressCb) {
  const results = [];
  let totalTested = 0;

  for (const rr of RR_RATIOS) {
    for (const maxBars of MAX_BARS_OPTS) {
      // ATR-based stops
      for (const atrMult of ATR_MULTS) {
        for (const atrPeriod of ATR_PERIODS) {
          const s = applyExitPatch(baseStrategy, { atrMult, atrPeriod, rr, maxBars, stopType: "atr" });
          try {
            const { stats } = runSignalScan(bars, s);
            const sc = score(stats, minTrades);
            results.push({ strategy: s, stats, score: sc, pass: 2 });
          } catch (_) { /* skip */ }
          totalTested++;
        }
      }
      // Percent-based stops
      for (const pctStop of PCT_STOPS) {
        const s = applyExitPatch(baseStrategy, { pctStop, rr, maxBars, stopType: "pct" });
        try {
          const { stats } = runSignalScan(bars, s);
          const sc = score(stats, minTrades);
          results.push({ strategy: s, stats, score: sc, pass: 2 });
        } catch (_) { /* skip */ }
        totalTested++;
      }
      if (progressCb && totalTested % 80 === 0)
        progressCb({ phase: 2, tested: totalTested, total: "?" });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// ─── Pass 3: Direction + Logic global sweep ───────────────────────────────────

function flipCondId(id) {
  const map = {
    ema_cross_up: "ema_cross_down", ema_cross_down: "ema_cross_up",
    ema_above_slow: "ema_below_slow", ema_below_slow: "ema_above_slow",
    price_above_ema: "price_below_ema", price_below_ema: "price_above_ema",
    macd_hist_pos: "macd_hist_neg", macd_hist_neg: "macd_hist_pos",
    macd_above_signal: "macd_below_signal", macd_below_signal: "macd_above_signal",
    rsi_oversold: "rsi_overbought", rsi_overbought: "rsi_oversold",
    price_above_vwap: "price_below_vwap", price_below_vwap: "price_above_vwap",
    higher_high: "lower_low", lower_low: "higher_high",
    ema_slope_up: "ema_slope_down", ema_slope_down: "ema_slope_up",
    adx_trending: "adx_trending",  // direction-neutral — same for both sides
  };
  return map[id] ?? null;
}

function pass3DirectionLogic(bars, candidateStrategies, minTrades, progressCb, directions = ["long", "short"]) {
  const results = [];
  let totalTested = 0;
  const top3 = candidateStrategies.slice(0, 3);

  for (const base of top3) {
    for (const direction of directions) {
      for (const logic of ["AND", "OR"]) {
        const s = clone(base.strategy);
        s.entry.direction = direction;
        s.entry.logic     = logic;
        // Flip condition IDs to align with new direction
        if (base.strategy.entry.direction !== direction) {
          s.entry.conditions = s.entry.conditions.map(c => {
            const flipped = flipCondId(c.id);
            return flipped ? { ...c, id: flipped } : c;
          });
        }
        try {
          const { stats } = runSignalScan(bars, s);
          const sc = score(stats, minTrades);
          results.push({ strategy: s, stats, score: sc, pass: 3 });
        } catch (_) { /* skip */ }
        totalTested++;
        if (progressCb) progressCb({ phase: 3, tested: totalTested, total: top3.length * directions.length * 2 });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// ─── Pass 3b: Gate Injection ─────────────────────────────────────────────────
/**
 * Takes the best strategy found so far and tests appending each gate condition
 * from GATE_VARIANTS.  Keeps the gate only when it improves the score —
 * this prevents gates from destroying signal count on thin datasets.
 */
function pass3bGateInjection(bars, topCandidates, minTrades, progressCb) {
  const results = [];
  let tested = 0;
  const top3 = topCandidates.slice(0, 3);

  for (const base of top3) {
    // Also try the base strategy without any gate (score it fresh)
    results.push(base);

    for (const gate of GATE_VARIANTS) {
      for (const logicForGate of ["AND"]) { // gates are always AND-combined
        const s = clone(base.strategy);
        // Avoid adding duplicate gate
        const alreadyHas = s.entry.conditions.some(c => c.id === gate.id);
        if (alreadyHas) continue;
        s.entry.conditions = [
          ...s.entry.conditions,
          makeCond(gate.id, gate.params),
        ];
        s.entry.logic = "AND"; // gate forces AND
        try {
          const { stats } = runSignalScan(bars, s);
          const sc = score(stats, minTrades, s);  // gates that add vol/ATR/VWAP get diversity bonus
          // Only keep if the gate doesn't destroy trade count below minimum
          if (stats.total >= minTrades) {
            results.push({ strategy: s, stats, score: sc, pass: "3b" });
          }
        } catch (_) { /* skip */ }
        tested++;
        if (progressCb) progressCb({ phase: "3b", tested });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, tested };
}

// ─── Pass 4: Walk-Forward Out-of-Sample Validation ───────────────────────────
/**
 * Splits bars into a training window (first trainPct%) and an OOS window
 * (remaining).  Re-evaluates the top candidates from in-sample optimisation
 * on the OOS window and returns only those that remain profitable.
 *
 * This is the institutional standard for avoiding backtest overfitting:
 * if a strategy can't survive on unseen data it is rejected, regardless
 * of how well it scored in-sample.
 *
 * @param {object[]} bars           full candle array
 * @param {object[]} candidates     top-N strategy results from passes 0-3
 * @param {object}   opts
 * @param {number}   opts.trainPct  fraction of bars used as training window (default 0.70)
 * @param {number}   opts.minOOSTrades  minimum trades in OOS window to validate (default 3)
 */
function pass4WalkForward(bars, candidates, opts = {}) {
  const { trainPct = 0.70, minOOSTrades = 3 } = opts;

  const splitIdx  = Math.floor(bars.length * trainPct);
  const oosBars   = bars.slice(splitIdx);

  if (oosBars.length < 50) {
    // Not enough OOS data — return candidates unchanged with a warning flag
    return candidates.map(r => ({ ...r, oos: null, oosPass: null }));
  }

  // Compute regime once for OOS window
  const oosRegime = classifyRegimes(oosBars);
  const derived   = { _regimeResult: oosRegime };

  const validated = candidates.map(r => {
    try {
      const { stats: oosStats } = runSignalScan(oosBars, r.strategy, { ...derived });
      const oosPass =
        oosStats.total >= minOOSTrades &&
        oosStats.profit_factor != null &&
        oosStats.profit_factor > 1.0 &&
        (oosStats.avg_rr ?? 0) >= 0.8;

      return {
        ...r,
        oos: {
          trades:       oosStats.total,
          profit_factor: oosStats.profit_factor,
          win_rate:     oosStats.win_rate,
          avg_rr:       oosStats.avg_rr,
          net_pnl_usd:  oosStats.net_pnl_usd,
        },
        oosPass,
      };
    } catch (_) {
      return { ...r, oos: null, oosPass: false };
    }
  });

  // Sort: OOS-valid first, then by in-sample score
  validated.sort((a, b) => {
    if (a.oosPass && !b.oosPass) return -1;
    if (!a.oosPass && b.oosPass) return 1;
    return b.score - a.score;
  });

  return validated;
}

// ─── Pass 5: SQS Threshold Sweep ─────────────────────────────────────────────
/**
 * After the best strategy is selected via walk-forward validation, sweep
 * the SQS minimum threshold (0 = off, 40..70 = selective filtering) to find
 * the level that maximises Sharpe on the training window while preserving
 * trade count.
 *
 * A fresh EdgeCache is used per sweep so there is no leakage between runs.
 */
const SQS_THRESHOLDS = [0, 35, 40, 45, 50, 55, 60, 65, 70];

async function pass5SQSThreshold(bars, baseStrategy, baseFees, minTrades, progressCb, abortFn) {
  const trainBars = bars.slice(0, Math.floor(bars.length * 0.70));
  const splitIdx  = Math.floor(bars.length * 0.70);
  const oosBars   = bars.slice(splitIdx);
  const feeRt     = (baseFees?.entry_pct ?? 0) + (baseFees?.exit_pct ?? 0);
  const rrRatio   = baseStrategy.exit?.take_profit?.ratio ?? 2.0;

  let bestSQS      = 0;
  let bestScore    = -Infinity;
  const sqsResults = [];

  for (let i = 0; i < SQS_THRESHOLDS.length; i++) {
    if (abortFn?.()) break;
    const minSQS = SQS_THRESHOLDS[i];

    // Report progress before each threshold so the UI updates
    if (progressCb) progressCb({ phase: 5, tested: i, total: SQS_THRESHOLDS.length });
    await yieldUI();

    const edgeCache = new EdgeCache();
    const qOpts     = minSQS === 0
      ? {}                                   // 0 = disable SQS gate
      : { enabled: true, minSQS, feeRtPct: feeRt, rrRatio, edgeCache, autoRecord: true };

    try {
      // Train on first 70%
      const { stats: trainStats } = runSignalScan(trainBars, baseStrategy, {}, qOpts);
      if (!trainStats || trainStats.total < minTrades) continue;

      // Validate on OOS (same edgeCache — carries over learned posteriors)
      const qOOSOpts = minSQS === 0 ? {} : { ...qOpts, autoRecord: false };
      const { stats: oosStats } = runSignalScan(oosBars, baseStrategy, {}, qOOSOpts);

      const combinedScore = score(trainStats, minTrades) * 0.6 +
                            score(oosStats,  Math.max(2, Math.floor(minTrades / 2))) * 0.4;

      sqsResults.push({ minSQS, trainStats, oosStats, combinedScore });

      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestSQS   = minSQS;
      }
    } catch (_) { /* skip */}
  }

  // Final progress update
  if (progressCb) progressCb({ phase: 5, tested: SQS_THRESHOLDS.length, total: SQS_THRESHOLDS.length });

  return { bestSQS, bestScore, sqsResults };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedup(results, topN) {
  const seen   = new Set();
  const unique = [];
  for (const r of results) {
    const key = JSON.stringify({
      dir:   r.strategy.entry.direction,
      logic: r.strategy.entry.logic,
      conds: r.strategy.entry.conditions.map(c => ({ id: c.id, p: c.params })),
      exit:  {
        sl:  r.strategy.exit.stop_loss,
        rr:  r.strategy.exit.take_profit?.ratio,
        mb:  r.strategy.exit.max_bars,
      },
    });
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
      if (unique.length >= topN) break;
    }
  }
  return unique;
}

// ─── Pass 6: Ensemble Blend (reporting-only) ─────────────────────────────────────
/**
 * Blends the top 3 strategies by requiring 2-of-N signal agreement for entry.
 * Trade simulation uses the best strategy’s exit params on consensus bars only.
 *
 * This is REPORTING-ONLY — the ensemble result is stored in passStats.ensemble
 * and never auto-promoted above individual strategies in topResults.  Its value
 * is as a high-conviction signal filter the user can study alongside the
 * individual results.
 *
 * Returns null when fewer than 2 strategies are available or the consensus has
 * insufficient trades to be meaningful.
 */
function pass6Ensemble(bars, topCandidates, minTrades) {
  if (topCandidates.length < 2) return null;
  const top3 = topCandidates.slice(0, Math.min(3, topCandidates.length));

  // Run each strategy to collect signal bar indices
  const sigSets = top3.map(c => {
    try {
      const { signals } = runSignalScan(bars, c.strategy);
      return new Set(signals.map(s => s.barIdx));
    } catch { return new Set(); }
  });

  if (sigSets.every(s => s.size === 0)) return null;

  // Find bar indices where at least 2 strategies agree
  const n         = bars.length;
  const consensus = new Set();
  for (let i = 0; i < n; i++) {
    if (sigSets.filter(s => s.has(i)).length >= 2) consensus.add(i);
  }

  if (consensus.size < minTrades) {
    return { insufficient: true, consensusBars: consensus.size, strategies: top3.length };
  }

  // Simulate trades using the best strategy’s exit params at consensus bars only
  const bestStrat   = top3[0].strategy;
  const { exit, risk, fees } = bestStrat;
  const atrPeriod   = exit.stop_loss?.params?.period ?? 14;
  const atrArr      = calcATR(bars, atrPeriod);
  const direction   = bestStrat.entry.direction;
  const isLong      = direction !== "short";
  const accountSize = risk?.account_size       ?? 1000;
  const riskPct     = risk?.risk_per_trade_pct ?? 1.0;
  const feeEntry    = (fees?.entry_pct ?? 0) / 100;
  const feeExit     = (fees?.exit_pct  ?? 0) / 100;
  const rrRatio     = exit.take_profit?.ratio ?? 2.0;
  const maxBars     = exit.max_bars ?? 48;

  const trades = [];
  let inTrade = false, tradeOpen = null;

  for (let i = 1; i < n; i++) {
    if (!inTrade && consensus.has(i)) {
      const atr   = atrArr[i] || (bars[i].h - bars[i].l);
      const price = bars[i].c;
      let stopDist;
      if (exit.stop_loss?.type === "atr") {
        stopDist = atr * (exit.stop_loss.params?.multiplier ?? 2.0);
      } else if (exit.stop_loss?.type === "pct") {
        stopDist = price * (exit.stop_loss.params?.pct ?? 1.0) / 100;
      } else {
        stopDist = atr * 2.0;
      }
      const stop     = isLong ? price - stopDist : price + stopDist;
      const target   = isLong ? price + stopDist * rrRatio : price - stopDist * rrRatio;
      const riskUSD  = accountSize * riskPct / 100;
      const qty      = stopDist > 0 ? riskUSD / stopDist : 0;
      inTrade   = true;
      tradeOpen = { entryIdx: i, t: bars[i].t, price, stop, target, stopDist, qty };
      continue;
    }

    if (inTrade && tradeOpen) {
      const bar      = bars[i];
      const barsHeld = i - tradeOpen.entryIdx;
      const hitStop   = isLong ? bar.l <= tradeOpen.stop   : bar.h >= tradeOpen.stop;
      const hitTarget = isLong ? bar.h >= tradeOpen.target : bar.l <= tradeOpen.target;
      const expiry    = barsHeld >= maxBars;
      if (hitStop || hitTarget || expiry) {
        let exitPrice, exitReason;
        if (hitTarget)    { exitPrice = tradeOpen.target; exitReason = "tp"; }
        else if (hitStop) { exitPrice = tradeOpen.stop;   exitReason = "sl"; }
        else              { exitPrice = bar.c;            exitReason = "expiry"; }
        const pnlPts   = (isLong ? 1 : -1) * (exitPrice - tradeOpen.price);
        const grossUSD = pnlPts * tradeOpen.qty;
        const feesUSD  = (tradeOpen.price + exitPrice) * tradeOpen.qty *
                         ((feeEntry + feeExit) / 2);  // symmetric approx
        const pnlUSD   = grossUSD - feesUSD;
        const pnlRR    = pnlPts / tradeOpen.stopDist;
        trades.push({
          entryT: tradeOpen.t, exitT: bar.t,
          entryPrice: tradeOpen.price, exitPrice, direction,
          qty: tradeOpen.qty,
          pnlPts: +pnlPts.toFixed(6), grossUSD: +grossUSD.toFixed(2),
          feesUSD: +feesUSD.toFixed(2), pnlUSD: +pnlUSD.toFixed(2),
          pnlRR: +pnlRR.toFixed(2),
          barsHeld, exitReason,
        });
        inTrade = false; tradeOpen = null;
      }
    }
  }

  const stats = computeTradeStats(trades);
  return {
    stats,
    score:         score(stats, minTrades),
    consensusBars: consensus.size,
    strategies:    top3.length,
    insufficient:  false,
  };
}

// ─── Pass 7: Auto-Pivot Scan ────────────────────────────────────────────────────
/**
 * Runs each built-in pivot strategy through runSignalScan and returns all
 * that fired at least one trade, ranked by score (or profit_factor as
 * fallback for sub-threshold results).  Called only when the main 5-pass
 * optimiser failed to find a profitable strategy.
 *
 * @param {object[]} bars
 * @param {number}   minTrades   minimum trade count to score normally
 * @param {Function} progressCb
 * @param {Function} abortFn     returns true when AbortController fired
 * @param {object}   derived     shared indicator cache from buildIndicatorCache
 * @returns {Promise<{ results: object[], tested: number }>}
 */
async function pass7AutoPivot(bars, minTrades, progressCb, abortFn, derived = {}) {
  const pivots  = getPivotStrategies();
  const results = [];

  for (let pi = 0; pi < pivots.length; pi++) {
    if (abortFn()) break;
    if (progressCb) progressCb({ phase: 7, tested: pi, total: pivots.length });

    // Yield after every 3 pivots to keep the UI responsive
    if (pi > 0 && pi % 3 === 0) await yieldUI();

    try {
      const { trades } = runSignalScan(bars, pivots[pi], derived);
      if (!trades.length) continue;
      const stats = computeTradeStats(trades);
      if (!stats || stats.total === 0) continue;

      // Early-prune: if profit_factor is catastrophically bad skip immediately
      if ((stats.profit_factor ?? 0) < 0.3) continue;

      const sc = score(stats, minTrades);
      results.push({ strategy: pivots[pi], stats, score: sc, pass: 7, isPivot: true });
    } catch { /* skip malformed pivots */ }
  }

  results.sort((a, b) => {
    // Finite scores first, then fallback by profit_factor
    const sa = isFinite(a.score) ? a.score : -1e6 + (a.stats?.profit_factor ?? 0) * 1000;
    const sb = isFinite(b.score) ? b.score : -1e6 + (b.stats?.profit_factor ?? 0) * 1000;
    return sb - sa;
  });

  return { results, tested: pivots.length };
}

// ─── Pass 8: Multi-TF Measurement ──────────────────────────────────────────────
/**
 * Re-runs the best strategy against higher timeframes derived by resampling
 * the existing bars array.  Averaging stats across TFs gives a truer picture
 * of edge robustness than an in-sample backtest on one TF alone.
 *
 * Only TFs that are strictly higher than the current one AND that produce
 * at least 50 bars are tested.  Resampled bars are cached per TF to avoid
 * redundant resampling if called multiple times.
 *
 * @param {object[]} bars      bars at the user’s current TF
 * @param {object}   strategy  strategy to test on each TF
 * @param {string}   baseTF    e.g. "15m" — the user’s current TF
 * @param {Function} progressCb
 * @returns {Promise<object|null>}  multiTFStats object or null if no data
 */
/**
 * Loosen regime/vol-gate conditions in a strategy clone for higher TFs.
 * These gates (regime_tradeable, forecast_clears_fees) filter out too much
 * of the smaller bar-count on 1h/4h/1d and produce false zero-trade results.
 */
function _loosenHigherTFOpt(strategy, tfMin) {
  if (tfMin < 60) return strategy;
  const s = clone(strategy);
  s.entry.conditions = (s.entry.conditions ?? []).map(c => {
    if (c.id === 'regime_tradeable') {
      const thr = tfMin >= 1440 ? 12 : 16;
      return { ...c, params: { ...c.params, adx_threshold: Math.min(c.params?.adx_threshold ?? 22, thr) } };
    }
    if (c.id === 'forecast_clears_fees') {
      const mg = tfMin >= 1440 ? 1.0 : 1.3;
      return { ...c, params: { ...c.params, margin: Math.min(c.params?.margin ?? 2.0, mg) } };
    }
    return c;
  });
  return s;
}

// All standard report TFs in ascending order
const ALL_SCAN_TFS = [
  { tf: "1m",  min: 1    },
  { tf: "5m",  min: 5    },
  { tf: "15m", min: 15   },
  { tf: "1h",  min: 60   },
  { tf: "4h",  min: 240  },
  { tf: "1d",  min: 1440 },
];

async function runMultiTFScan(bars, strategy, baseTF, progressCb, preferHigherTF = false) {
  const baseMin = tfToMinutes(baseTF);

  // Always test all 6 standard TFs that are >= base resolution
  // (we can only up-sample, not down-sample)
  const targets = ALL_SCAN_TFS.filter(x => x.min >= baseMin);
  if (!targets.length) return null;

  const barsCache = new Map([[baseMin, bars]]);
  const tfResults  = [];   // TFs with trades > 0
  const allTFData  = [];   // all TFs tested, including zeros (for diagnostic)

  let step = 0;
  for (const { tf, min: tfMin } of targets) {
    step++;
    if (progressCb) progressCb({ phase: 8, tested: step, total: targets.length });
    await yieldUI();

    // Build or reuse resampled bars
    if (!barsCache.has(tfMin)) barsCache.set(tfMin, resample(bars, tfMin));
    const tfBars = barsCache.get(tfMin);

    // Need at least 50 bars after resampling; skip with reason if not enough
    if (tfBars.length < 50) {
      console.debug(`[MTF] ${tf} skip: only ${tfBars.length} bars after resample`);
      allTFData.push({ tf, tfMin, stats: null, zero_signals: true, reason: `only_${tfBars.length}_bars` });
      continue;
    }

    // Apply loosened gates for higher TFs to avoid over-filtering
    const strat = _loosenHigherTFOpt(strategy, tfMin);

    try {
      const { stats } = runSignalScan(tfBars, strat);
      const hasData = stats?.total > 0;
      console.debug(
        `[MTF] ${tf}: PF=${stats?.profit_factor ?? 0} trades=${stats?.total ?? 0} bars=${tfBars.length}` +
        (tfMin >= 60 && !hasData ? ' ← zero (loosened gates)' : '')
      );
      if (hasData) {
        tfResults.push({ tf, tfMin, stats });
        allTFData.push({ tf, tfMin, stats, zero_signals: false });
      } else {
        allTFData.push({ tf, tfMin, stats, zero_signals: true, reason: 'no_trades_after_loosening' });
      }
    } catch (err) {
      console.warn(`[MTF] ${tf} error:`, err?.message ?? err);
      allTFData.push({ tf, tfMin, stats: null, zero_signals: true, reason: 'scan_error' });
    }
  }

  if (!tfResults.length) {
    // Return diagnostic object even when every TF has zero results
    console.warn('[MTF] All TFs returned zero trades. Check strategy conditions.');
    return {
      tfs: [], avg_profit_factor: 0, avg_win_rate: 0,
      avg_net_pnl_usd: 0, avg_trade_count: 0,
      weighted_avg_pf: 0, best_higher_tf: null,
      prefer_higher_tf: preferHigherTF,
      per_tf: allTFData,
      all_zero: true,
    };
  }

  const avg = key =>
    tfResults.reduce((s, r) => s + (r.stats[key] ?? 0), 0) / tfResults.length;

  // Weighted PF: 4h = 40 %, 1h = 30 %, others share remaining evenly
  const WEIGHTS = { 240: 0.40, 60: 0.30 };
  let wSum = 0, wPF = 0;
  const otherCount = Math.max(1, tfResults.filter(x => !WEIGHTS[x.tfMin]).length);
  for (const r of tfResults) {
    const w = WEIGHTS[r.tfMin] ?? (0.30 / otherCount);
    wPF  += w * (r.stats.profit_factor ?? 0);
    wSum += w;
  }
  const weighted_avg_pf = wSum > 0 ? +(wPF / wSum).toFixed(3) : +avg('profit_factor').toFixed(3);

  const higherTFResults = tfResults.filter(r => r.tfMin > baseMin);
  const bestHigherTF    = higherTFResults.length
    ? higherTFResults.slice().sort((a, b) => (b.stats.profit_factor ?? 0) - (a.stats.profit_factor ?? 0))[0]
    : null;

  return {
    tfs:               tfResults.map(r => r.tf),
    avg_profit_factor: +avg('profit_factor').toFixed(3),
    avg_win_rate:      +avg('win_rate').toFixed(1),
    avg_net_pnl_usd:   +avg('net_pnl_usd').toFixed(2),
    avg_trade_count:   +avg('total').toFixed(1),
    weighted_avg_pf,
    best_higher_tf:    bestHigherTF
      ? { tf: bestHigherTF.tf, pf: +(bestHigherTF.stats.profit_factor ?? 0).toFixed(3) }
      : null,
    prefer_higher_tf:  preferHigherTF,
    per_tf:            allTFData,   // includes zero-result entries for diagnostics
    all_zero:          false,
  };
}

// ─── UI yield helper ─────────────────────────────────────────────────────────
/** Yields execution back to the browser so it can repaint / respond to events. */
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

// ─── Async inner-loop wrappers ────────────────────────────────────────────────
// These mirror the sync pass functions but await yieldUI() every CHUNK iterations
// so the progress bar stays alive and the browser doesn't show "wait/exit".

const CHUNK = 80; // yield every N combinations

async function pass0ConditionSelectionAsync(bars, baseExit, minTrades, progressCb, directions, baseRisk, baseFees, derived = {}) {
  const results = [];
  let totalTested = 0;

  function tryStrategy(direction, logic, conditions) {
    const s = makeStrategy(direction, logic, conditions, baseExit, baseRisk, baseFees);
    try {
      const { stats } = runSignalScan(bars, s, derived);
      const sc = score(stats, minTrades);
      return { strategy: s, stats, score: sc, pass: 0 };
    } catch (_) { return null; }
  }

  for (const direction of directions) {
    const relevantIds = direction === "long" ? LONG_COND_IDS : SHORT_COND_IDS;
    const singleBests = [];

    for (const id of relevantIds) {
      let best = null;
      const variants = condParamVariants(id, "standard");
      for (let vi = 0; vi < variants.length; vi++) {
        const r = tryStrategy(direction, "AND", [makeCond(id, variants[vi])]);
        totalTested++;
        if (r && r.score > (best?.score ?? -Infinity)) best = r;
        if (totalTested % CHUNK === 0) {
          if (progressCb) progressCb({ phase: 0, tested: totalTested, total: "?" });
          await yieldUI();
        }
      }
      if (best && best.score > -Infinity)
        singleBests.push({ id, result: best, condObj: best.strategy.entry.conditions[0] });
    }

    singleBests.sort((a, b) => b.result.score - a.result.score);
    const top8 = singleBests.slice(0, 8);
    const top4 = top8.slice(0, 4);
    for (const { result } of top8) results.push(result);

    for (let i = 0; i < top8.length; i++) {
      for (let j = i + 1; j < top8.length; j++) {
        for (const logic of ["AND", "OR"]) {
          const r = tryStrategy(direction, logic, [top8[i].condObj, top8[j].condObj]);
          totalTested++;
          if (r) results.push(r);
          if (totalTested % CHUNK === 0) {
            if (progressCb) progressCb({ phase: 0, tested: totalTested, total: "?" });
            await yieldUI();
          }
        }
      }
    }
    for (let i = 0; i < top4.length; i++) {
      for (let j = i + 1; j < top4.length; j++) {
        for (let k = j + 1; k < top4.length; k++) {
          for (const logic of ["AND", "OR"]) {
            const r = tryStrategy(direction, logic, [top4[i].condObj, top4[j].condObj, top4[k].condObj]);
            totalTested++;
            if (r) results.push(r);
            if (totalTested % CHUNK === 0) {
              if (progressCb) progressCb({ phase: 0, tested: totalTested, total: "?" });
              await yieldUI();
            }
          }
        }
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

async function pass1EntryParamsAsync(bars, baseStrategy, minTrades, level, progressCb, derived = {}) {
  const results = [];
  const conditions = (baseStrategy.entry.conditions ?? []).filter(c => c.enabled !== false);
  let totalTested = 0;
  const perCond = conditions.map(c => condParamVariants(c.id, level));
  const crossSize = perCond.reduce((acc, arr) => acc * arr.length, 1);
  let combos;
  if (crossSize <= 600) {
    combos = cartesian(perCond).map(paramSets =>
      conditions.map((c, i) => ({ id: c.id, params: paramSets[i] }))
    );
  } else {
    // OFAT: each condition's param sweep is independent of the others.
    // Run up to `concurrency` sweeps in parallel via Promise.all so their
    // yieldUI() points interleave — keeps the UI alive without waiting for
    // each condition to finish sequentially.  On single-threaded JS this is
    // cooperative multitasking; on multi-core environments (e.g. Worker pools)
    // it enables true parallelism.
    const concurrency = Math.min(
      conditions.length,
      Math.max(1, ((globalThis.navigator?.hardwareConcurrency ?? 2) - 1))
    );

    const sweepCond = async (ci) => {
      const baseParts   = conditions.map(c => ({ id: c.id, params: c.params }));
      const condResults = [];
      for (const ps of perCond[ci]) {
        const s = clone(baseStrategy);
        s.entry.conditions = baseParts.map((bp, i) =>
          i === ci ? makeCond(bp.id, ps) : makeCond(bp.id, bp.params)
        );
        try {
          const { stats } = runSignalScan(bars, s, derived);
          const sc = score(stats, minTrades, s);
          condResults.push({ strategy: s, stats, score: sc, pass: 1 });
        } catch (_) { /* skip */ }
        totalTested++;
        if (totalTested % CHUNK === 0) {
          if (progressCb) progressCb({ phase: 1, tested: totalTested, total: '~OFAT' });
          await yieldUI();
        }
      }
      return condResults;
    };

    // Dispatch conditions in parallel batches of `concurrency`
    for (let ci = 0; ci < conditions.length; ci += concurrency) {
      const end   = Math.min(ci + concurrency, conditions.length);
      const batch = Array.from({ length: end - ci }, (_, k) => sweepCond(ci + k));
      const batchResults = await Promise.all(batch);
      for (const br of batchResults) results.push(...br);
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// Reduced ATR grid used during early-prune mode: representative without exhaustive sweep.
// 3 multipliers × 1 period vs full 9×4 = 36.  PCT stops always use full range.
const ATR_MULTS_REDUCED   = [1.5, 2.0, 2.5];
const ATR_PERIODS_REDUCED = [14];

async function pass2ExitParamsAsync(bars, baseStrategy, minTrades, progressCb, derived = {}) {
  const t2 = performance.now();
  const results = [];
  let totalTested    = 0;
  let pruneActive    = false;   // activated after first RR when bestPF < 0.50
  let prunedBranches = 0;

  // Un-pruned total for initial progress bar estimate
  const totalCombos = RR_RATIOS.length * MAX_BARS_OPTS.length *
                      (ATR_MULTS.length * ATR_PERIODS.length + PCT_STOPS.length);

  for (let ri = 0; ri < RR_RATIOS.length; ri++) {
    const rr = RR_RATIOS[ri];

    // ── Early pruning: inspect best PF after the first complete RR value ─────
    // If no combo reached PF ≥ 0.50 in the first 1/9 of the search, the entry
    // strategy is unlikely to be profitable and we reduce the ATR grid for the
    // remaining 8 RR values.  This saves ~68% of combos on low-quality datasets.
    if (ri === 1 && results.length > 0) {
      const bestPF = results.reduce((m, r) => Math.max(m, r.stats?.profit_factor ?? 0), 0);
      pruneActive  = bestPF < 0.50;
      if (pruneActive) {
        console.debug(
          `[Optimizer Pass2] ⚡ Early prune activated (bestPF=${bestPF.toFixed(3)} < 0.5). ` +
          `Reducing ATR grid: ${ATR_MULTS.length}×${ATR_PERIODS.length} → ` +
          `${ATR_MULTS_REDUCED.length}×${ATR_PERIODS_REDUCED.length} for ` +
          `${RR_RATIOS.length - 1} remaining RR values.`
        );
      }
    }

    const atrMultsToUse   = pruneActive ? ATR_MULTS_REDUCED   : ATR_MULTS;
    const atrPeriodsToUse = pruneActive ? ATR_PERIODS_REDUCED : ATR_PERIODS;

    for (const maxBars of MAX_BARS_OPTS) {
      for (const atrMult of atrMultsToUse) {
        for (const atrPeriod of atrPeriodsToUse) {
          const s = applyExitPatch(baseStrategy, { atrMult, atrPeriod, rr, maxBars, stopType: "atr" });
          try {
            const { stats } = runSignalScan(bars, s, derived);
            const sc = score(stats, minTrades);
            results.push({ strategy: s, stats, score: sc, pass: 2 });
          } catch (_) { /* skip */ }
          totalTested++;
          if (totalTested % CHUNK === 0) {
            if (progressCb) progressCb({ phase: 2, tested: totalTested, total: totalCombos });
            await yieldUI();
          }
        }
      }
      // PCT stops: always test full range (low combo count, different mechanism)
      for (const pctStop of PCT_STOPS) {
        const s = applyExitPatch(baseStrategy, { pctStop, rr, maxBars, stopType: "pct" });
        try {
          const { stats } = runSignalScan(bars, s, derived);
          const sc = score(stats, minTrades);
          results.push({ strategy: s, stats, score: sc, pass: 2 });
        } catch (_) { /* skip */ }
        totalTested++;
        if (totalTested % CHUNK === 0) {
          if (progressCb) progressCb({ phase: 2, tested: totalTested, total: totalCombos });
          await yieldUI();
        }
      }
      if (pruneActive) prunedBranches++;
    }
  }

  const elapsed = (performance.now() - t2).toFixed(0);
  const finalBestPF = results.reduce((m, r) => Math.max(m, r.stats?.profit_factor ?? 0), 0);
  const savedCombos = prunedBranches *
    ((ATR_MULTS.length - ATR_MULTS_REDUCED.length) * ATR_PERIODS.length);
  console.debug(
    `[Optimizer Pass2] ${totalTested} combos in ${elapsed}ms · bestPF=${finalBestPF.toFixed(2)}` +
    (prunedBranches > 0
      ? ` · pruned ${prunedBranches} (saved ~${savedCombos} ATR combos, ~${Math.round(savedCombos / totalCombos * 100)}% of full grid)`
      : ' · no pruning (strategy showed early promise)')
  );

  results.sort((a, b) => b.score - a.score);
  return { results, tested: totalTested };
}

// ─── Main async export ────────────────────────────────────────────────────────

/**
 * optimizeStrategyAsync(bars, strategy, opts)
 *
 * Async version — yields to the browser between pass chunks so the UI stays
 * responsive and the progress bar updates.  Drop-in replacement for the sync
 * version in all Engine / UI call sites.
 *
 * @param {object[]} bars
 * @param {object}   strategy
 * @param {object}   [opts]  { topN, progressCb, signal, autoPivot, multiTF, baseTF }
 *   autoPivot  — if true and no profitable strategy found after Pass 5, tests
 *                all built-in pivot strategies (Pass 7) looking for PF > 1.0.
 *   multiTF    — if true, re-runs the best result against higher resampled TFs
 *                and returns averaged stats in passStats.multiTFStats (Pass 8).
 *   baseTF     — current chart timeframe string (e.g. "15m") used for multi-TF
 *                resampling.  Defaults to "15m" when omitted.
 * @returns {Promise<{ best, topResults, passStats }>}
 */
export async function optimizeStrategyAsync(bars, strategy, opts = {}) {
  const { topN = 5, progressCb, signal, autoPivot = false,
          multiTF = false, baseTF = "15m", preferHigherTF = false } = opts;
  const t0 = performance.now();
  const aborted = () => signal?.aborted === true;

  const dirPref   = strategy.entry?.direction;
  const directions = dirPref === "long"  ? ["long"]
                   : dirPref === "short" ? ["short"]
                   : ["long", "short"];

  let allResults = [];
  let p0t = 0, p1t = 0, p2t = 0, p3t = 0;
  let foundProfitable = false;
  let expandedSearch  = false;

  const baseExit = strategy.exit ?? {
    stop_loss:   { type: "atr", params: { period: 14, multiplier: 1.5 } },
    take_profit: { type: "rr",  ratio: 2.0 },
    max_bars:    48,
  };
  const baseRisk = strategy.risk ?? { account_size: 1000, risk_per_trade_pct: 1 };
  const baseFees = strategy.fees ?? { entry_pct: 0, exit_pct: 0 };

  // Pre-compute all indicator arrays once — shared across every pass and combo.
  // Avoids redundant calcEMA/calcATR calls for the same period across ~2,700+ combos.
  const sharedDerived = buildIndicatorCache(bars);

  for (const minTrades of [6, 4, 3]) {
    for (const paramLevel of ["standard", "expanded"]) {
      if (aborted()) break;

      if (progressCb) progressCb({ phase: 0, tested: 0, total: "?" });
      await yieldUI();
      const p0 = await pass0ConditionSelectionAsync(bars, baseExit, minTrades, progressCb, directions, baseRisk, baseFees, sharedDerived);
      p0t += p0.tested;
      allResults.push(...p0.results.filter(r => (r.stats?.total ?? 0) > 0));
      if (aborted()) break;

      const seedStrategy = [...allResults].sort((a, b) => b.score - a.score)[0]?.strategy ?? strategy;

      if (progressCb) progressCb({ phase: 1, tested: 0, total: "?" });
      await yieldUI();
      const p1 = await pass1EntryParamsAsync(bars, seedStrategy, minTrades, paramLevel, progressCb, sharedDerived);
      p1t += p1.tested;
      allResults.push(...p1.results.filter(r => (r.stats?.total ?? 0) > 0));
      if (aborted()) break;

      const p1Best = [...allResults].sort((a, b) => b.score - a.score)[0]?.strategy ?? seedStrategy;

      if (progressCb) progressCb({ phase: 2, tested: 0, total: "?" });
      await yieldUI();
      const p2 = await pass2ExitParamsAsync(bars, p1Best, minTrades, progressCb, sharedDerived);
      p2t += p2.tested;
      allResults.push(...p2.results.filter(r => (r.stats?.total ?? 0) > 0));
      if (aborted()) break;

      if (progressCb) progressCb({ phase: 3, tested: 0, total: "?" });
      await yieldUI();
      const p2sorted = [...allResults].sort((a, b) => b.score - a.score);
      const p3 = pass3DirectionLogic(bars, p2sorted, minTrades, progressCb, directions);
      p3t += p3.tested;
      allResults.push(...p3.results.filter(r => (r.stats?.total ?? 0) > 0));
      if (aborted()) break;

      if (progressCb) progressCb({ phase: "3b", tested: 0, total: GATE_VARIANTS.length * 3 });
      await yieldUI();
      const preGate = [...allResults].sort((a, b) => b.score - a.score).slice(0, 5);
      const p3b = pass3bGateInjection(bars, preGate, minTrades, progressCb);
      allResults.push(...p3b.results.filter(r => (r.stats?.total ?? 0) > 0));

      if (progressCb) progressCb({ phase: 4, tested: 0, total: 10 });
      await yieldUI();
      const preWF = [...allResults].sort((a, b) => b.score - a.score).slice(0, 10);
      const wfResults = pass4WalkForward(bars, preWF, { trainPct: 0.70, minOOSTrades: 3 });
      for (const wf of wfResults) {
        if (wf.oos) {
          const orig = allResults.find(r => JSON.stringify(r.strategy) === JSON.stringify(wf.strategy));
          if (orig) { orig.oos = wf.oos; orig.oosPass = wf.oosPass; }
        }
      }

      const oosValid = allResults.filter(r => r.oosPass === true);
      const best = oosValid.length
        ? oosValid.sort((a, b) => b.score - a.score)[0]
        : [...allResults].sort((a, b) => b.score - a.score)[0];

      if (best && isProfitable(best.stats)) { foundProfitable = true; break; }
      expandedSearch = true;
    }
    if (foundProfitable || aborted()) break;
  }

  // Sort: OOS-valid first, then by score descending.
  // When score is -Infinity (sub-threshold but still fired trades), fall back to
  // trade count × win-rate so the user still sees the "best of worst" results.
  function _rankScore(r) {
    if (isFinite(r.score)) return r.score;
    const s = r.stats;
    if (!s) return -1e9;
    return -1e6 + (s.total ?? 0) * ((s.win_rate ?? 0) / 50);
  }
  function topResults_sort_fn(a, b) {
    if ((a.oosPass === true) && (b.oosPass !== true)) return -1;
    if ((a.oosPass !== true) && (b.oosPass === true)) return 1;
    return _rankScore(b) - _rankScore(a);
  }
  allResults.sort(topResults_sort_fn);
  let topResults = dedup(allResults, topN);
  const usedFallback = topResults.length > 0 && !topResults.some(r => isFinite(r.score));

  if (progressCb) progressCb({ phase: 5, tested: 0, total: SQS_THRESHOLDS.length });
  await yieldUI();
  const bestForSQS = topResults[0];
  let p5Result = null;
  if (bestForSQS && !aborted()) {
    p5Result = await pass5SQSThreshold(bars, bestForSQS.strategy, baseFees, 4, progressCb, aborted);
  }

  // Pass 6 — ensemble blend (reporting-only, never auto-promotes over individuals)
  if (progressCb) progressCb({ phase: 6, tested: 0, total: topResults.length });
  await yieldUI();
  let p6Result = null;
  if (!aborted() && topResults.length >= 2) {
    p6Result = pass6Ensemble(bars, topResults, 4);
  }

  // Pass 7 — Auto-Pivot: if no profitable result found, test built-in pivot strategies
  let pivotsTested = 0;
  let pivotResults = [];
  if (!aborted() && autoPivot && !foundProfitable) {
    if (progressCb) progressCb({ phase: 7, tested: 0, total: 7 });
    await yieldUI();
    const p7 = await pass7AutoPivot(bars, 3, progressCb, aborted, sharedDerived);
    pivotsTested  = p7.tested;
    pivotResults  = p7.results;
    // Merge into allResults then recompute topResults — profitable pivots bubble up
    if (pivotResults.length) {
      allResults.push(...pivotResults);
      for (const pr of pivotResults) {
        if (pr.stats && isProfitable(pr.stats)) foundProfitable = true;
      }
      allResults.sort(topResults_sort_fn);
      topResults = dedup(allResults, topN);
    }
  }

  // Pass 8 — Multi-TF: run the best strategy across resampled higher timeframes
  let multiTFStats = null;
  let promotedToHigherTF = false;
  if (!aborted() && multiTF && topResults.length > 0) {
    if (progressCb) progressCb({ phase: 8, tested: 0, total: 4 });
    await yieldUI();
    multiTFStats = await runMultiTFScan(bars, topResults[0].strategy, baseTF, progressCb, preferHigherTF);
    // Promotion: use the best strategy's actual base-TF PF (from passes 0-7),
    // not the multi-TF average which gets pulled up when higher TFs are good.
    const baseTFPF = topResults[0]?.stats?.profit_factor ?? 0;
    if (preferHigherTF && multiTFStats?.best_higher_tf?.pf >= 1.1 &&
        (baseTFPF < 0.9 || !foundProfitable)) {
      promotedToHigherTF = true;
      // Store metadata so the panel can show a specific recommendation
      multiTFStats._promoted = {
        from: { tf: baseTF, pf: +baseTFPF.toFixed(3) },
        to:   multiTFStats.best_higher_tf,
      };
    }
  }

  // ── Diversity diagnostics ─────────────────────────────────────────────────
  const top50 = allResults.slice(0, 50);
  const _condFreq = {};
  for (const r of top50) {
    for (const c of (r?.strategy?.entry?.conditions ?? [])) {
      _condFreq[c.id] = (_condFreq[c.id] ?? 0) + 1;
    }
  }
  const _diverseInTop50 = top50.filter(r =>
    r.strategy?.entry?.conditions?.some(c => DIVERSE_COND_IDS.has(c.id))
  ).length;
  console.log('[Optimizer] Condition usage across top-50 results:', _condFreq);
  console.log(`[Optimizer] Strategies using VWAP/volume/ADX/ATR (diverse): ${_diverseInTop50}/${top50.length}`);

  const elapsed = (performance.now() - t0).toFixed(0);
  return {
    best:       topResults[0]?.strategy ?? strategy,
    topResults,
    passStats: {
      p0Combos:          p0t,
      p1Combos:          p1t,
      p2Combos:          p2t,
      p3Combos:          p3t,
      totalCombos:       p0t + p1t + p2t + p3t,
      elapsedMs:         elapsed,
      validResults:      allResults.length,
      foundProfitable,
      expandedSearch,
      recommendedMinSQS: p5Result?.bestSQS  ?? 0,
      sqsSweepResults:   p5Result?.sqsResults ?? [],
      oosValidCount:     allResults.filter(r => r.oosPass === true).length,
      ensemble:          p6Result,
      usedFallback,
      pivotsTested,
      multiTFStats,
      promotedToHigherTF,
      promotedToTF:  multiTFStats?._promoted?.to?.tf  ?? null,
      promotedToPF:  multiTFStats?._promoted?.to?.pf  ?? null,
      promotedFromTF:multiTFStats?._promoted?.from?.tf ?? null,
      promotedFromPF:multiTFStats?._promoted?.from?.pf ?? null,
      aborted:           aborted(),
    },
  };
}

/**
 * strategyDiff(original, optimized)
 * Returns array of { label, from, to } change descriptors.
 */
export function strategyDiff(original, optimized) {
  const diffs = [];

  if (original.entry.direction !== optimized.entry.direction)
    diffs.push({ label: "Direction", from: original.entry.direction, to: optimized.entry.direction });

  if (original.entry.logic !== optimized.entry.logic)
    diffs.push({ label: "Logic", from: original.entry.logic, to: optimized.entry.logic });

  const oConds = original.entry.conditions ?? [];
  const nConds = optimized.entry.conditions ?? [];

  if (oConds.length !== nConds.length)
    diffs.push({ label: "Condition count", from: oConds.length, to: nConds.length });

  const maxC = Math.max(oConds.length, nConds.length);
  for (let i = 0; i < maxC; i++) {
    const oc = oConds[i]; const nc = nConds[i];
    if (!oc && nc) { diffs.push({ label: `Cond ${i+1}`, from: "(none)", to: nc.id }); continue; }
    if (oc && !nc) { diffs.push({ label: `Cond ${i+1}`, from: oc.id, to: "(removed)" }); continue; }
    if (oc.id !== nc.id) { diffs.push({ label: `Cond ${i+1} type`, from: oc.id, to: nc.id }); continue; }
    for (const [k, v] of Object.entries(nc.params ?? {})) {
      if ((oc.params ?? {})[k] !== v)
        diffs.push({ label: `${nc.id} › ${k}`, from: (oc.params ?? {})[k], to: v });
    }
  }

  const oe = original.exit ?? {}; const ne = optimized.exit ?? {};
  const oSl = oe.stop_loss?.params;  const nSl = ne.stop_loss?.params;

  if (oe.stop_loss?.type !== ne.stop_loss?.type)
    diffs.push({ label: "Stop type", from: oe.stop_loss?.type, to: ne.stop_loss?.type });
  if (oSl?.multiplier !== nSl?.multiplier && nSl?.multiplier != null)
    diffs.push({ label: "ATR mult", from: oSl?.multiplier, to: nSl?.multiplier });
  if (oSl?.period !== nSl?.period && nSl?.period != null)
    diffs.push({ label: "ATR period", from: oSl?.period, to: nSl?.period });
  if (oSl?.pct !== nSl?.pct && nSl?.pct != null)
    diffs.push({ label: "Stop %", from: oSl?.pct, to: nSl?.pct });

  const oRR = oe.take_profit?.ratio; const nRR = ne.take_profit?.ratio;
  if (oRR !== nRR) diffs.push({ label: "R:R ratio", from: oRR, to: nRR });

  if (oe.max_bars !== ne.max_bars)
    diffs.push({ label: "Max bars", from: oe.max_bars, to: ne.max_bars });

  return diffs;
}
