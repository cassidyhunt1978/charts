/**
 * RegimeEngine.js — Market Regime Classifier
 *
 * Assigns every bar to one of five mutually-exclusive regimes using a
 * multi-factor model drawn from institutional volatility-regime literature:
 *
 *   trending_bull      — ADX≥threshold, EMA slope positive, ATR within normal band
 *   trending_bear      — ADX≥threshold, EMA slope negative, ATR within normal band
 *   breakout_pending   — ATR percentile < 25th (compression) → energy coiling
 *   volatile_chaos     — ATR spike > 90th percentile without ADX directionality
 *   ranging_tight      — everything else (low ADX, no compression, no spike)
 *
 * Useful as:
 *  - A pre-gate in SignalQuality (only trade trending_* and breakout_pending)
 *  - A backtesting segmentation axis (how does the strategy perform per regime)
 *  - A real-time HUD indicator
 *
 * Pure functions — no DOM/canvas dependencies.
 */

import { calcEMA, calcATR, calcADX } from "../util/indicators.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default configuration — all tunable via opts */
const DEFAULTS = {
  adxPeriod:         14,
  adxTrendThreshold: 22,   // ADX ≥ this → trending (institutional standard is 25; 22 more sensitive)
  emaSlopePeriod:    21,
  emaSlopeLookback:  4,    // bars of EMA slope to check direction
  atrPeriod:         14,
  atrLookback:       100,  // rolling window for ATR percentile
  compressionPct:    25,   // ATR below this percentile of lookback → breakout_pending
  chaosPct:          88,   // ATR above this percentile of lookback → volatile_chaos
};

// ─── Regime Labels ────────────────────────────────────────────────────────────

export const REGIMES = {
  TRENDING_BULL:    "trending_bull",
  TRENDING_BEAR:    "trending_bear",
  BREAKOUT_PENDING: "breakout_pending",
  VOLATILE_CHAOS:   "volatile_chaos",
  RANGING_TIGHT:    "ranging_tight",
};

// ─── ATR Percentile Helper ────────────────────────────────────────────────────

/**
 * For each bar, compute what percentile its ATR value falls within a
 * rolling lookback window.  Returns float[] 0–100.
 */
function calcATRPercentile(atrArr, lookback) {
  const out = new Array(atrArr.length).fill(null);
  for (let i = 0; i < atrArr.length; i++) {
    if (atrArr[i] == null) continue;
    const start  = Math.max(0, i - lookback + 1);
    const window = atrArr.slice(start, i + 1).filter(v => v != null);
    if (window.length < 5) continue; // need at least 5 samples for meaningful percentile
    const sorted = window.slice().sort((a, b) => a - b);
    const rank   = sorted.filter(v => v <= atrArr[i]).length;
    out[i] = (rank / sorted.length) * 100;
  }
  return out;
}

// ─── Bollinger Band Width Percentile (compression confirmation) ───────────────

function calcBBWidthPercentile(bars, period = 20, stdMult = 2.0, lookback = 100) {
  const closes = bars.map(b => b.c);
  const widths = new Array(bars.length).fill(null);

  for (let i = period - 1; i < bars.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std   = Math.sqrt(variance);
    widths[i]   = (std * stdMult * 2) / mean; // normalised width as % of price
  }

  const pcts = new Array(bars.length).fill(null);
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] == null) continue;
    const start  = Math.max(0, i - lookback + 1);
    const window = widths.slice(start, i + 1).filter(v => v != null);
    if (window.length < 5) continue;
    const sorted = window.slice().sort((a, b) => a - b);
    const rank   = sorted.filter(v => v <= widths[i]).length;
    pcts[i] = (rank / sorted.length) * 100;
  }
  return pcts;
}

// ─── Core Classifier ─────────────────────────────────────────────────────────

/**
 * classifyRegimes(bars, opts?)
 *
 * @param {object[]} bars   — full candle array {t,o,h,l,c,v?}
 * @param {object}   [opts] — override any DEFAULTS key
 * @returns {{
 *   regimes:    string[],         // regime label per bar (length === bars.length)
 *   adx:        (number|null)[],
 *   atrPct:     (number|null)[],
 *   bbWidthPct: (number|null)[],
 *   emaBull:    boolean[],        // true when EMA slope is positive
 * }}
 */
export function classifyRegimes(bars, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  if (!bars || bars.length < cfg.adxPeriod * 2) {
    return {
      regimes:    new Array(bars?.length ?? 0).fill(REGIMES.RANGING_TIGHT),
      adx:        [],
      atrPct:     [],
      bbWidthPct: [],
      emaBull:    [],
    };
  }

  const closes = bars.map(b => b.c);
  const adxArr = calcADX(bars, cfg.adxPeriod);
  const atrArr = calcATR(bars, cfg.atrPeriod);
  const emaArr = calcEMA(closes, cfg.emaSlopePeriod);

  const atrPct     = calcATRPercentile(atrArr, cfg.atrLookback);
  const bbWidthPct = calcBBWidthPercentile(bars, 20, 2.0, cfg.atrLookback);

  const n        = bars.length;
  const regimes  = new Array(n).fill(REGIMES.RANGING_TIGHT);
  const emaBull  = new Array(n).fill(false);

  for (let i = cfg.emaSlopeLookback; i < n; i++) {
    const adx  = adxArr[i];
    const aPct = atrPct[i];
    const bPct = bbWidthPct[i];

    // EMA slope direction
    const emaNow  = emaArr[i];
    const emaPrev = emaArr[i - cfg.emaSlopeLookback];
    const slopeUp = emaNow != null && emaPrev != null && emaNow > emaPrev;
    emaBull[i] = slopeUp;

    if (adx == null || aPct == null) continue;

    // ── Priority order: Chaos > Compression > Trending > Ranging
    if (aPct >= cfg.chaosPct && adx < cfg.adxTrendThreshold) {
      // High ATR spike without trend confirmation → unpredictable, avoid
      regimes[i] = REGIMES.VOLATILE_CHAOS;
    } else if ((aPct <= cfg.compressionPct) && (bPct == null || bPct <= cfg.compressionPct + 10)) {
      // ATR contracting into a squeeze → energy coiling before breakout
      regimes[i] = REGIMES.BREAKOUT_PENDING;
    } else if (adx >= cfg.adxTrendThreshold) {
      // Strong trend — classify direction by EMA slope
      regimes[i] = slopeUp ? REGIMES.TRENDING_BULL : REGIMES.TRENDING_BEAR;
    } else {
      regimes[i] = REGIMES.RANGING_TIGHT;
    }
  }

  return { regimes, adx: adxArr, atrPct, bbWidthPct, emaBull };
}

// ─── Single-bar lookup (used by SignalQuality and real-time HUD) ───────────────

/**
 * getRegimeAt(regimeResult, barIdx)
 * Quick accessor returning the regime string at a specific bar index.
 */
export function getRegimeAt(regimeResult, barIdx) {
  return regimeResult?.regimes?.[barIdx] ?? REGIMES.RANGING_TIGHT;
}

/**
 * isTradeable(regime, direction?)
 *
 * Returns true when the regime is worth trading.
 * Optional direction check: trending_bull only permits longs, trending_bear only shorts.
 *
 * @param {string} regime
 * @param {string} [direction]  "long" | "short" | undefined (both allowed)
 */
export function isTradeable(regime, direction) {
  if (regime === REGIMES.VOLATILE_CHAOS) return false;
  if (regime === REGIMES.RANGING_TIGHT)  return false;
  if (direction === "long"  && regime === REGIMES.TRENDING_BEAR) return false;
  if (direction === "short" && regime === REGIMES.TRENDING_BULL) return false;
  return true;
}

// ─── Rolling regime summary (analytics / HUD overlay) ────────────────────────

/**
 * regimeSummary(regimes, lookback?)
 * Returns a breakdown of what percentage of the last `lookback` bars were
 * spent in each regime.
 *
 * @param {string[]} regimes
 * @param {number}   [lookback=200]
 * @returns {{ [regimeKey: string]: number }}  values sum to 100
 */
export function regimeSummary(regimes, lookback = 200) {
  const slice  = regimes.slice(-lookback).filter(r => r != null);
  const counts = {};
  for (const r of Object.values(REGIMES)) counts[r] = 0;
  for (const r of slice) if (r in counts) counts[r]++;
  const total = slice.length || 1;
  const out = {};
  for (const [k, v] of Object.entries(counts)) out[k] = +((v / total) * 100).toFixed(1);
  return out;
}

// ─── Regime streak (how many consecutive bars in current regime) ──────────────

/**
 * regimeStreak(regimes)
 * Returns { regime, streak } for the most recent bar.
 */
export function regimeStreak(regimes) {
  if (!regimes?.length) return { regime: REGIMES.RANGING_TIGHT, streak: 0 };
  const current = regimes[regimes.length - 1];
  let streak = 0;
  for (let i = regimes.length - 1; i >= 0; i--) {
    if (regimes[i] === current) streak++;
    else break;
  }
  return { regime: current, streak };
}
