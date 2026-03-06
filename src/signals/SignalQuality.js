/**
 * SignalQuality.js — Signal Quality Score (SQS) Engine
 *
 * Every signal that passes entry conditions gets scored 0–100 across four
 * independent components before a trade is permitted.  Trades are only taken
 * when SQS ≥ configurable threshold (default 55).
 *
 * Component breakdown:
 *
 *  [0–30]  Volatility Adequacy
 *          Is the current ATR large enough that the expected move, scaled by
 *          R:R, can absorb round-trip fees and still be profitable?
 *          Formula: clamp( (atrPct / price × 100) / requiredMovePct, 0, 1 ) × 30
 *
 *  [0–25]  Regime Alignment
 *          Does the signal direction match the current market regime?
 *          Full 25 pts for trending_bull (long) / trending_bear (short)
 *          15 pts for breakout_pending (direction-neutral edge)
 *          0 pts for ranging_tight / volatile_chaos (regime gate: SQS hard-capped to 40)
 *
 *  [0–25]  Historical Conditional Edge (Bayesian Posterior)
 *          Weighted win-rate from prior trades with the same condition set and
 *          regime class.  Updates dynamically as the trade log grows.
 *          Computed via updateBayesianEdgeCache() and queryEdge().
 *
 *  [0–20]  Multi-Timeframe Confluence
 *          Is the signal direction aligned with the higher-TF trend?
 *          Derived from the EMA slope on 4× the current bar resolution.
 *          If no MTF data is available, this component contributes 10 pts neutral.
 *
 * Usage:
 *   // once at startup / after backtest
 *   const edgeCache = buildEdgeCache(tradeHistory, barRegimes);
 *
 *   // per signal at bar i
 *   const sqs = computeSQS(bars, i, direction, conditionIds, regimeResult, {
 *     rrRatio: 2.0,
 *     feeRtPct: 0.65,
 *     edgeCache,
 *     htfBars,           // optional higher-TF bars for MTF component
 *     minSQS: 55,        // caller can read sqs.passes
 *   });
 */

import { calcATR } from "../util/indicators.js";
import { classifyRegimes, isTradeable, REGIMES } from "./RegimeEngine.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SQS = 55;

/**
 * The required move (as % of price, gross of fees) for a trade to be
 * worthwhile.  Conservative: fees × R:R × safety_margin.
 * This is the denominator normaliser for the volatility component.
 */
function requiredMovePct(feeRtPct, rrRatio, margin = 2.0) {
  return feeRtPct * rrRatio * margin;
}

// ─── Component 1: Volatility Adequacy ────────────────────────────────────────

/**
 * Score 0–30 based on whether current ATR can support a profitable trade.
 *
 * @param {object[]} bars
 * @param {number}   i            bar index
 * @param {number}   feeRtPct     round-trip fee as % of price (e.g. 0.65)
 * @param {number}   rrRatio      target R:R ratio
 * @param {number}   atrPeriod
 * @returns {{ score: number, atrPct: number, required: number, atrSlope: number }}
 */

/**
 * Compute the OLS slope of the last `n` ATR values, normalised by their mean.
 * Returns a signed fraction: positive = expanding volatility, negative = contracting.
 * Used to bias scoreVolatilityAdequacy: reward setups where vol is rising into a
 * potential breakout, penalise setups where vol has already peaked.
 *
 * @param {number[]} atrArr
 * @param {number}   idx      bar index (inclusive upper bound)
 * @param {number}   n        look-back window
 * @returns {number}  normalised slope (dimensionless)
 */
function _atrLinearSlope(atrArr, idx, n = 20) {
  const vals = [];
  for (let j = Math.max(0, idx - n + 1); j <= idx; j++) {
    if (atrArr[j] != null && atrArr[j] > 0) vals.push(atrArr[j]);
  }
  if (vals.length < 5) return 0;          // not enough data — treat as neutral
  const m    = vals.length;
  const sumX  = m * (m - 1) / 2;
  const sumX2 = m * (m - 1) * (2 * m - 1) / 6;
  const sumY  = vals.reduce((s, v) => s + v, 0);
  const sumXY = vals.reduce((s, v, i) => s + i * v, 0);
  const denom = m * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (m * sumXY - sumX * sumY) / denom;
  const avg   = sumY / m;
  return avg > 0 ? slope / avg : 0;       // normalise → dimensionless fraction
}

export function scoreVolatilityAdequacy(bars, i, feeRtPct, rrRatio, atrPeriod = 14) {
  const atrArr  = calcATR(bars, atrPeriod);
  const atr     = atrArr[i];
  const price   = bars[i]?.c;

  if (!atr || !price || price === 0) return { score: 0, atrPct: 0, required: 0, atrSlope: 0 };

  const atrPct   = (atr / price) * 100;
  const req      = requiredMovePct(feeRtPct, rrRatio);
  const ratio    = Math.min(atrPct / req, 1);          // clamped 0–1

  // ATR trend projection: reward expanding volatility, penalise contracting.
  //   slope > +0.05  →  ×1.15 bonus  (vol accelerating into potential breakout)
  //   slope < -0.05  →  ×0.80 penalty (vol has likely peaked, reversion risk)
  //   neutral zone   →  ×1.00
  const atrSlope  = _atrLinearSlope(atrArr, i);
  const slopeMult = atrSlope > 0.05 ? 1.15 : atrSlope < -0.05 ? 0.80 : 1.0;
  const score     = Math.round(Math.min(ratio * 30 * slopeMult, 30));

  return { score, atrPct: +atrPct.toFixed(4), required: +req.toFixed(4), atrSlope: +atrSlope.toFixed(4) };
}

// ─── Component 2: Regime Alignment ───────────────────────────────────────────

/**
 * Score 0–25 based on regime-direction alignment.
 * Also returns `hard_block` when regime is completely untradeable.
 *
 * @param {string} regime     current regime label for bar i
 * @param {string} direction  "long" | "short"
 * @returns {{ score: number, hard_block: boolean, regime: string }}
 */
export function scoreRegimeAlignment(regime, direction) {
  switch (regime) {
    case REGIMES.TRENDING_BULL:
      return { score: direction === "long" ? 25 : 5,  hard_block: false, regime };
    case REGIMES.TRENDING_BEAR:
      return { score: direction === "short" ? 25 : 5, hard_block: false, regime };
    case REGIMES.BREAKOUT_PENDING:
      return { score: 15, hard_block: false, regime }; // either direction valid
    case REGIMES.VOLATILE_CHAOS:
      return { score: 0,  hard_block: true,  regime }; // do not trade
    case REGIMES.RANGING_TIGHT:
    default:
      return { score: 0,  hard_block: true,  regime }; // do not trade
  }
}

// ─── Component 3: Bayesian Conditional Edge ───────────────────────────────────

/**
 * Cache key: "<direction>|<regime>|<sorted_condition_ids>"
 * Stores Bayesian posterior: { wins, total, prior }
 */
export class EdgeCache {
  constructor(prior = { wins: 3, total: 6 }) {
    this._data  = {};       // key → { wins, total }
    this._prior = prior;    // weak prior — 50% win rate, prevents division by zero
  }

  /**
   * Ingest completed trade results to update the cache.
   * @param {object[]} tradeResults  array of { direction, regime, conditionIds: string[], won: bool }
   */
  update(tradeResults) {
    for (const t of tradeResults) {
      const key = this._key(t.direction, t.regime, t.conditionIds);
      if (!this._data[key]) this._data[key] = { wins: 0, total: 0 };
      this._data[key].total++;
      if (t.won) this._data[key].wins++;
    }
  }

  /**
   * Query posterior win-rate for a given setup.
   * Falls back to prior if not enough data.
   * @returns {{ winRate: number, n: number, reliable: boolean }}
   */
  query(direction, regime, conditionIds) {
    const key    = this._key(direction, regime, conditionIds);
    const stored = this._data[key] ?? { wins: 0, total: 0 };

    // Bayesian estimate: blend observed with prior
    const pWins  = this._prior.wins   + stored.wins;
    const pTotal = this._prior.total  + stored.total;
    const winRate = pWins / pTotal;

    return {
      winRate:  +winRate.toFixed(4),
      n:        stored.total,
      reliable: stored.total >= 8,   // only trust it after 8+ observations
    };
  }

  /**
   * Reset cache (e.g. on full reoptimize)
   */
  clear() { this._data = {}; }

  /** Serialise for persistence / export */
  toJSON() { return JSON.parse(JSON.stringify(this._data)); }

  /** Restore from serialised object */
  fromJSON(obj) { this._data = obj ?? {}; }

  _key(direction, regime, conditionIds) {
    const ids = [...(conditionIds ?? [])].sort().join(",");
    return `${direction}|${regime}|${ids}`;
  }
}

// Singleton — shared across the app session
export const globalEdgeCache = new EdgeCache();

/**
 * Score 0–25 from the Bayesian posterior win-rate.
 *
 * Mapping: 50% WR → 12.5 pts (neutral), 70%+ WR → 25 pts, <30% WR → 0 pts.
 *
 * @param {{ winRate, n, reliable }} edgeResult
 * @returns {{ score: number, winRate: number, reliable: boolean }}
 */
export function scoreEdge(edgeResult) {
  const { winRate, n, reliable } = edgeResult;

  // Scale: 0% WR → 0 pts, 50% WR → 12 pts, 100% WR → 25 pts (linear)
  const raw   = Math.max(0, Math.min(winRate * 25, 25));
  // Dampen if unreliable (few obs): blend toward neutral 12 pts
  const score = reliable
    ? Math.round(raw)
    : Math.round(raw * 0.5 + 12 * 0.5); // blend toward neutral

  return { score, winRate, reliable, n };
}

// ─── Component 4: Multi-Timeframe Confluence ─────────────────────────────────

/**
 * Score 0–20 based on whether the higher-TF trend agrees with the signal direction.
 *
 * If `htfBars` is provided: compute EMA slope on it to determine HTF trend.
 * If not: neutral 10 pts (no penalisation when data unavailable).
 *
 * @param {object[]} htfBars    higher-timeframe candles (e.g. 4H when main is 1H)
 * @param {string}   direction  "long" | "short"
 * @param {number}   emaPeriod  EMA period to judge HTF trend
 * @returns {{ score: number, htfTrend: string|null }}
 */
export function scoreMTFConfluence(htfBars, direction, emaPeriod = 21) {
  if (!htfBars || htfBars.length < emaPeriod + 4) {
    // No HTF data — neutral, don't penalise
    return { score: 10, htfTrend: null };
  }

  // Use classifyRegimes for the HTF bars — use last bar's regime
  const htfResult = classifyRegimes(htfBars, { adxPeriod: 14, adxTrendThreshold: 22 });
  const lastRegime = htfResult.regimes[htfResult.regimes.length - 1];
  const htfBull    = htfResult.emaBull[htfResult.emaBull.length - 1];

  const htfTrend = htfBull ? "bull" : "bear";

  // Full alignment
  if ((direction === "long"  && htfTrend === "bull") ||
      (direction === "short" && htfTrend === "bear")) {
    return { score: 20, htfTrend };
  }

  // Breakout pending — ambiguous higher TF, partial credit
  if (lastRegime === REGIMES.BREAKOUT_PENDING) {
    return { score: 12, htfTrend };
  }

  // Counter-trend on HTF — penalise heavily
  return { score: 2, htfTrend };
}

// ─── Component 5: Fee-adjusted Kelly Fraction ────────────────────────────────

/**
 * Score 0–15 based on the fee-adjusted Kelly fraction from the Bayesian
 * posterior edge.  Kelly f* is re-derived with fee drag folded directly
 * into the R-unit payoffs so the fraction reflects net-of-cost edge:
 *
 *   adjWin  = rrRatio − (feeRtPct / 100)   ← winner nets less after fee
 *   adjLoss = 1 + (feeRtPct / 100)          ← loser costs slightly more
 *   f*      = (p × adjWin − q × adjLoss) / adjWin
 *
 * Quarter-Kelly cap [0, 0.25] is applied before scaling to 0–15 pts.
 * Unreliable edge data (< 8 observations) is blended toward neutral (4 pts).
 *
 * @param {{ winRate: number, n: number, reliable: boolean }} edgeResult
 * @param {number} rrRatio    target R:R ratio (e.g. 2.0)
 * @param {number} feeRtPct   round-trip fee as % of price (e.g. 0.65)
 * @returns {{ score: number, kelly: number, feeAdjusted: true }}
 */
export function scoreKellyComponent(edgeResult, rrRatio = 2.0, feeRtPct = 0.65) {
  const { winRate, reliable } = edgeResult ?? {};
  if (!winRate || !rrRatio || rrRatio <= 0)
    return { score: 0, kelly: 0, feeAdjusted: true };

  const p        = Math.min(Math.max(winRate, 0.01), 0.99);
  const q        = 1 - p;
  const feeFrac  = feeRtPct / 100;                      // fractional cost per price unit
  const adjWinR  = Math.max(rrRatio - feeFrac, 0.01);  // net win in R after fee
  const adjLossR = 1 + feeFrac;                         // net loss in R after fee

  const fullKelly = (p * adjWinR - q * adjLossR) / adjWinR;
  if (fullKelly <= 0) return { score: 0, kelly: 0, feeAdjusted: true };

  // Quarter-Kelly clamped [0, 0.25]
  const fraction = Math.min(Math.max(fullKelly * 0.25, 0), 0.25);

  // Scale 0–0.25 → 0–15 pts; blend toward 4 pts when edge is unreliable
  const raw   = (fraction / 0.25) * 15;
  const score = reliable
    ? Math.round(Math.min(raw, 15))
    : Math.round(raw * 0.6 + 4 * 0.4);

  return { score: Math.min(score, 15), kelly: +fraction.toFixed(4), feeAdjusted: true };
}

// ─── Master SQS Calculator ────────────────────────────────────────────────────

/**
 * computeSQS — single entry point used by SignalEngine and Optimizer.
 *
 * @param {object[]} bars          full candle array
 * @param {number}   barIdx        signal bar index
 * @param {string}   direction     "long" | "short"
 * @param {string[]} conditionIds  active condition IDs that fired
 * @param {object}   regimeResult  return value of classifyRegimes()
 * @param {object}   [opts]
 * @param {number}   [opts.rrRatio=2.0]
 * @param {number}   [opts.feeRtPct=0.65]
 * @param {number}   [opts.atrPeriod=14]
 * @param {EdgeCache}[opts.edgeCache]   globalEdgeCache by default
 * @param {object[]} [opts.htfBars]     higher-TF bars for MTF component
 * @param {number}   [opts.minSQS]      threshold for .passes flag
 *
 * @returns {{
 *   total:     number,            // 0–100
 *   passes:    boolean,           // total >= minSQS
 *   hard_block:boolean,           // regime says abort unconditionally
 *   breakdown: {
 *     volatility: object,
 *     regime:     object,
 *     edge:       object,
 *     mtf:        object,
 *     kelly:      object,   // Component 5: fee-adjusted Kelly (0–15 pts)
 *   },
 * }}
 */
// Max raw total: 30+25+25+20+15 = 115 — clamped to 100 in return.
export function computeSQS(bars, barIdx, direction, conditionIds, regimeResult, opts = {}) {
  const {
    rrRatio    = 2.0,
    feeRtPct   = 0.65,
    atrPeriod  = 14,
    edgeCache  = globalEdgeCache,
    htfBars    = null,
    minSQS     = DEFAULT_MIN_SQS,
  } = opts;

  const regime  = regimeResult?.regimes?.[barIdx] ?? REGIMES.RANGING_TIGHT;

  // Component 2 first — hard_block short-circuits everything
  const regComp = scoreRegimeAlignment(regime, direction);
  if (regComp.hard_block) {
    return {
      total:      regComp.score,
      passes:     false,
      hard_block: true,
      breakdown:  { volatility: null, regime: regComp, edge: null, mtf: null },
    };
  }

  // Component 1
  const volComp  = scoreVolatilityAdequacy(bars, barIdx, feeRtPct, rrRatio, atrPeriod);

  // Component 3
  const edgeQ    = edgeCache.query(direction, regime, conditionIds);
  const edgeComp = scoreEdge(edgeQ);

  // Component 4
  const mtfComp  = scoreMTFConfluence(htfBars, direction);

  // Component 5: fee-adjusted Kelly fraction from Bayesian posterior edge.
  // Rewards setups where net-of-fee edge is large enough to justify sizing up.
  const kellyComp = scoreKellyComponent(edgeQ, rrRatio, feeRtPct);

  const total = volComp.score + regComp.score + edgeComp.score + mtfComp.score + kellyComp.score;

  return {
    total:      Math.min(total, 100),
    passes:     total >= minSQS,
    hard_block: false,
    breakdown:  {
      volatility: volComp,
      regime:     regComp,
      edge:       edgeComp,
      mtf:        mtfComp,
      kelly:      kellyComp,
    },
  };
}

// ─── Expected Value Gate ───────────────────────────────────────────────────────

/**
 * expectedValue(winRate, avgWin, avgLoss, feeRtPct, price, qty)
 *
 * Computes the probability-weighted expected P&L of a pending trade NET of fees.
 * Returns a dollar figure — only enter when EV > 0 with a margin buffer.
 *
 *   EV = P(win) × avgWin − P(loss) × avgLoss − fee_rt_dollar
 *
 * @param {number} winRate    0–1
 * @param {number} avgWin     average winning trade P&L in USD
 * @param {number} avgLoss    average losing trade P&L in USD (positive number)
 * @param {number} feeRtPct   round-trip fee as % (e.g. 0.65)
 * @param {number} price      entry price
 * @param {number} qty        position size in units
 * @returns {{ ev: number, positive: boolean }}
 */
export function expectedValue(winRate, avgWin, avgLoss, feeRtPct, price, qty) {
  const feeDollar = (feeRtPct / 100) * price * qty;
  const ev        = winRate * avgWin - (1 - winRate) * avgLoss - feeDollar;
  return { ev: +ev.toFixed(4), positive: ev > 0 };
}

// ─── Fractional Kelly Position Sizing ────────────────────────────────────────

/**
 * kellySize(winRate, avgWinRR, kellyCap, accountSize, riskPerTradePct)
 *
 * Returns the position size multiplier (0–1) to apply to the base risk dollar.
 * Fractional Kelly (default cap 0.25) avoids geometric ruin on model error.
 *
 *   f* = (p × b − q) / b     where b = avgWinRR, p = winRate, q = 1 − p
 *
 * @param {number} winRate        0–1
 * @param {number} avgWinRR       average winner in R-multiples (e.g. 2.1R)
 * @param {number} kellyCap       maximum fraction of Kelly to use (default 0.25)
 * @returns {{ fraction: number, label: string }}
 *          fraction is 0–1 multiplier on base risk
 */
export function kellyFraction(winRate, avgWinRR, kellyCap = 0.25) {
  if (!winRate || !avgWinRR || avgWinRR <= 0) return { fraction: 0, label: "skip" };

  const p = Math.min(Math.max(winRate, 0.01), 0.99);
  const b = avgWinRR;
  const q = 1 - p;

  const fullKelly = (p * b - q) / b;

  if (fullKelly <= 0) return { fraction: 0, label: "skip" };  // negative EV

  const fraction = Math.min(fullKelly * kellyCap, kellyCap);

  const label =
    fraction >= kellyCap * 0.8 ? "strong"
    : fraction >= kellyCap * 0.4 ? "moderate"
    : "marginal";

  return { fraction: +fraction.toFixed(4), label };
}

// ─── Trade Result Recorder (feeds EdgeCache) ─────────────────────────────────

/**
 * recordTrade(trade, conditionIds, regime, edgeCache?)
 *
 * Should be called after each trade closes to keep the Bayesian edge cache
 * current.  Engine / Backtester calls this automatically when wired up.
 *
 * @param {object}    trade        completed trade object (from runSignalScan)
 * @param {string[]}  conditionIds array of condition IDs that fired at entry
 * @param {string}    regime       regime at the time of entry
 * @param {EdgeCache} [cache]      defaults to globalEdgeCache
 */
export function recordTrade(trade, conditionIds, regime, cache = globalEdgeCache) {
  cache.update([{
    direction:    trade.direction,
    regime:       regime ?? REGIMES.RANGING_TIGHT,
    conditionIds: conditionIds ?? [],
    won:          (trade.pnlUSD ?? trade.pnl ?? 0) > 0,
  }]);
}
