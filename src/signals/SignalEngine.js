/**
 * SignalEngine.js — MarketMind Strategy Signal Computer
 *
 * Scans bars + computed indicators and fires buy/sell signals based on
 * a configurable rule-set that can be exported to JSON and imported into
 * any Python automated trading engine.
 *
 * Logic is intentionally written as pure functions with no DOM or canvas
 * dependencies so Python can mirror it exactly.
 *
 * v2: Integrates RegimeEngine + SignalQuality for probabilistic pre-entry
 * gating.  runSignalScan() now accepts optional `qualityOpts` to enable
 * the SQS gate, regime filter, and Bayesian edge scoring.
 */

import { classifyRegimes, isTradeable } from "./RegimeEngine.js";
import { computeSQS, globalEdgeCache, recordTrade } from "./SignalQuality.js";

// ─── Indicator helpers ──────────────────────────────────────────────────────

/** Simple exponential moving average over a price array */
export function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] == null) continue;
    if (out[i - 1] == null) {
      // Seed with SMA of first `period` values
      if (i < period - 1) continue;
      let sum = 0, cnt = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (prices[j] != null) { sum += prices[j]; cnt++; }
      }
      out[i] = cnt === period ? sum / period : null;
    } else {
      out[i] = prices[i] * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

/** Average True Range */
export function calcATR(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const trs = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prev = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
  for (let i = period - 1; i < trs.length; i++) {
    if (i === period - 1) {
      out[i] = trs.slice(0, period).reduce((a, v) => a + v, 0) / period;
    } else if (out[i - 1] != null) {
      out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
    }
  }
  return out;
}

/** RSI */
export function calcRSI(prices, period = 14) {
  const out = new Array(prices.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    const gain  = delta > 0 ? delta : 0;
    const loss  = delta < 0 ? -delta : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/**
 * Average Directional Index (ADX) — trend strength indicator.
 * Returns adx[] where values > 25 indicate a trending market.
 */
export function calcADX(bars, period = 14) {
  const n = bars.length;
  const adx = new Array(n).fill(null);
  if (n < period * 2 + 1) return adx;

  const tr    = new Array(n).fill(0);
  const dmP   = new Array(n).fill(0);
  const dmM   = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    const ph = bars[i - 1].h, pl = bars[i - 1].l;
    tr[i]  = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph, dn = pl - l;
    dmP[i] = (up > dn && up > 0) ? up : 0;
    dmM[i] = (dn > up && dn > 0) ? dn : 0;
  }

  // Wilder's initial smoothed sums (skip index 0 which has no TR)
  let st = 0, sdp = 0, sdm = 0;
  for (let i = 1; i <= period; i++) { st += tr[i]; sdp += dmP[i]; sdm += dmM[i]; }

  const dxArr = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      st  = st  - st  / period + tr[i];
      sdp = sdp - sdp / period + dmP[i];
      sdm = sdm - sdm / period + dmM[i];
    }
    const dip = st > 0 ? 100 * sdp / st : 0;
    const dim = st > 0 ? 100 * sdm / st : 0;
    const dsum = dip + dim;
    dxArr[i] = dsum > 0 ? 100 * Math.abs(dip - dim) / dsum : 0;
  }

  // Smooth DX into ADX with another Wilder pass
  let adxVal = 0, cnt = 0;
  for (let i = period; i < period * 2 && i < n; i++) {
    adxVal += (dxArr[i] ?? 0); cnt++;
  }
  adxVal = cnt > 0 ? adxVal / cnt : 0;
  const adxStart = period * 2 - 1;
  if (adxStart < n) adx[adxStart] = adxVal;
  for (let i = adxStart + 1; i < n; i++) {
    adxVal = (adxVal * (period - 1) + (dxArr[i] ?? 0)) / period;
    adx[i] = adxVal;
  }
  return adx;
}

/** MACD — returns { macd[], signal[], hist[] } */
export function calcMACD(prices, fast = 12, slow = 26, sig = 9) {
  const eFast   = calcEMA(prices, fast);
  const eSlow   = calcEMA(prices, slow);
  const macdLine = prices.map((_, i) =>
    eFast[i] != null && eSlow[i] != null ? eFast[i] - eSlow[i] : null
  );
  const sigLine  = calcEMA(macdLine, sig);
  const hist     = macdLine.map((v, i) =>
    v != null && sigLine[i] != null ? v - sigLine[i] : null
  );
  return { macd: macdLine, signal: sigLine, hist };
}
// ─── Pivot Point Calculator ────────────────────────────────────────────────────

/**
 * Compute pivot levels (PP, R1–R4, S1–S4) for each bar using the OHLC of the
 * previous `period_hours` bucket.  Supports three formula types:
 *   classic   — traditional floor pivot (PP = (H+L+C)/3)
 *   woodie    — Woodie variant (PP = (H+L+2C)/4)  emphasises close
 *   camarilla — Camarilla variant (H/L levels scaled by 1.1 × range)
 *
 * For crypto’s 24/7 market the bucket boundary is midnight UTC.
 *
 * @param {object[]} bars         sorted ascending bars with {t,h,l,c,o?}
 * @param {'classic'|'woodie'|'camarilla'} type
 * @param {number}   period_hours bucket width in hours (default 24)
 * @returns {{ pp,r1,r2,r3,r4,s1,s2,s3,s4 }|null}[]  one entry per bar
 */
export function calcPivotPoints(bars, type = 'classic', period_hours = 24) {
  const periodMs = period_hours * 3_600_000;
  // First pass: accumulate OHLC per period bucket
  const buckets = new Map(); // bucket-key → { h, l, c, o }
  for (const bar of bars) {
    const key = Math.floor(bar.t / periodMs);
    const b   = buckets.get(key);
    if (!b) {
      buckets.set(key, { h: bar.h, l: bar.l, c: bar.c, o: bar.o ?? bar.c });
    } else {
      b.h = Math.max(b.h, bar.h);
      b.l = Math.min(b.l, bar.l);
      b.c = bar.c;  // last close in bucket
    }
  }
  // Second pass: for each bar assign levels from the previous bucket
  return bars.map(bar => {
    const key  = Math.floor(bar.t / periodMs);
    const prev = buckets.get(key - 1);
    if (!prev) return null;
    return _pivotLevels(prev.h, prev.l, prev.c, prev.o, type);
  });
}

/** @private */
function _pivotLevels(H, L, C, O, type) {
  const range = H - L;
  if (range <= 0) return null;
  let pp, r1, r2, r3, r4, s1, s2, s3, s4;
  if (type === 'camarilla') {
    r4 = C + range * (1.1 / 2);
    r3 = C + range * (1.1 / 4);
    r2 = C + range * (1.1 / 6);
    r1 = C + range * (1.1 / 12);
    s1 = C - range * (1.1 / 12);
    s2 = C - range * (1.1 / 6);
    s3 = C - range * (1.1 / 4);
    s4 = C - range * (1.1 / 2);
    pp = (H + L + C) / 3;
  } else if (type === 'woodie') {
    pp = (H + L + 2 * C) / 4;
    r1 = 2 * pp - L;
    r2 = pp + range;
    r3 = r1 + range;
    r4 = r2 + range;
    s1 = 2 * pp - H;
    s2 = pp - range;
    s3 = s1 - range;
    s4 = s2 - range;
  } else {  // classic / default
    pp = (H + L + C) / 3;
    r1 = 2 * pp - L;
    r2 = pp + range;
    r3 = r1 + range;
    r4 = r2 + range;
    s1 = 2 * pp - H;
    s2 = pp - range;
    s3 = s1 - range;
    s4 = s2 - range;
  }
  return { pp, r1, r2, r3, r4, s1, s2, s3, s4 };
}
// ─── Condition evaluators ────────────────────────────────────────────────────

/**
 * For each bar index, evaluate whether the condition is true.
 * Returns boolean[].
 */
function evalCondition(cond, bars, derived) {
  const n = bars.length;
  const result = new Array(n).fill(false);

  switch (cond.id) {

    case "ema_cross_up": {
      const fast = derived[`ema_${cond.params.fast}`] || calcEMA(bars.map(b => b.c), cond.params.fast);
      const slow = derived[`ema_${cond.params.slow}`] || calcEMA(bars.map(b => b.c), cond.params.slow);
      for (let i = 1; i < n; i++) {
        if (fast[i] != null && slow[i] != null && fast[i - 1] != null && slow[i - 1] != null)
          result[i] = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
      }
      break;
    }

    case "ema_cross_down": {
      const fast = derived[`ema_${cond.params.fast}`] || calcEMA(bars.map(b => b.c), cond.params.fast);
      const slow = derived[`ema_${cond.params.slow}`] || calcEMA(bars.map(b => b.c), cond.params.slow);
      for (let i = 1; i < n; i++) {
        if (fast[i] != null && slow[i] != null && fast[i - 1] != null && slow[i - 1] != null)
          result[i] = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
      }
      break;
    }

    case "ema_above_slow": {
      const fast = derived[`ema_${cond.params.fast}`] || calcEMA(bars.map(b => b.c), cond.params.fast);
      const slow = derived[`ema_${cond.params.slow}`] || calcEMA(bars.map(b => b.c), cond.params.slow);
      for (let i = 0; i < n; i++)
        result[i] = fast[i] != null && slow[i] != null && fast[i] > slow[i];
      break;
    }

    case "ema_below_slow": {
      const fast = derived[`ema_${cond.params.fast}`] || calcEMA(bars.map(b => b.c), cond.params.fast);
      const slow = derived[`ema_${cond.params.slow}`] || calcEMA(bars.map(b => b.c), cond.params.slow);
      for (let i = 0; i < n; i++)
        result[i] = fast[i] != null && slow[i] != null && fast[i] < slow[i];
      break;
    }

    case "price_above_ema": {
      const ema = derived[`ema_${cond.params.period}`] || calcEMA(bars.map(b => b.c), cond.params.period);
      for (let i = 0; i < n; i++)
        result[i] = ema[i] != null && bars[i].c > ema[i];
      break;
    }

    case "price_below_ema": {
      const ema = derived[`ema_${cond.params.period}`] || calcEMA(bars.map(b => b.c), cond.params.period);
      for (let i = 0; i < n; i++)
        result[i] = ema[i] != null && bars[i].c < ema[i];
      break;
    }

    case "macd_hist_pos": {
      const { hist } = calcMACD(bars.map(b => b.c),
        cond.params.fast || 12, cond.params.slow || 26, cond.params.sig || 9);
      for (let i = 1; i < n; i++)
        result[i] = hist[i] != null && hist[i] > 0 && (hist[i - 1] == null || hist[i - 1] <= 0);
      break;
    }

    case "macd_hist_neg": {
      const { hist } = calcMACD(bars.map(b => b.c),
        cond.params.fast || 12, cond.params.slow || 26, cond.params.sig || 9);
      for (let i = 1; i < n; i++)
        result[i] = hist[i] != null && hist[i] < 0 && (hist[i - 1] == null || hist[i - 1] >= 0);
      break;
    }

    case "macd_above_signal": {
      const { macd, signal } = calcMACD(bars.map(b => b.c),
        cond.params.fast || 12, cond.params.slow || 26, cond.params.sig || 9);
      for (let i = 0; i < n; i++)
        result[i] = macd[i] != null && signal[i] != null && macd[i] > signal[i];
      break;
    }

    case "macd_below_signal": {
      const { macd, signal } = calcMACD(bars.map(b => b.c),
        cond.params.fast || 12, cond.params.slow || 26, cond.params.sig || 9);
      for (let i = 0; i < n; i++)
        result[i] = macd[i] != null && signal[i] != null && macd[i] < signal[i];
      break;
    }

    case "rsi_oversold": {
      const rsi = calcRSI(bars.map(b => b.c), cond.params.period || 14);
      const lvl = cond.params.level || 30;
      for (let i = 1; i < n; i++)
        result[i] = rsi[i] != null && rsi[i] >= lvl && rsi[i - 1] != null && rsi[i - 1] < lvl;
      break;
    }

    case "rsi_overbought": {
      const rsi = calcRSI(bars.map(b => b.c), cond.params.period || 14);
      const lvl = cond.params.level || 70;
      for (let i = 1; i < n; i++)
        result[i] = rsi[i] != null && rsi[i] <= lvl && rsi[i - 1] != null && rsi[i - 1] > lvl;
      break;
    }

    case "rsi_in_zone": {
      const rsi = calcRSI(bars.map(b => b.c), cond.params.period || 14);
      for (let i = 0; i < n; i++)
        result[i] = rsi[i] != null && rsi[i] >= cond.params.min && rsi[i] <= cond.params.max;
      break;
    }

    case "price_above_vwap": {
      // VWAP resets daily — build it from bars grouped by UTC day
      const vwap = _buildVWAP(bars);
      for (let i = 0; i < n; i++)
        result[i] = vwap[i] != null && bars[i].c > vwap[i];
      break;
    }

    case "price_below_vwap": {
      const vwap = _buildVWAP(bars);
      for (let i = 0; i < n; i++)
        result[i] = vwap[i] != null && bars[i].c < vwap[i];
      break;
    }

    case "volume_spike": {
      const mult = cond.params.multiplier || 1.5;
      for (let i = 20; i < n; i++) {
        const avg = bars.slice(i - 20, i).reduce((s, b) => s + (b.v || 0), 0) / 20;
        result[i] = (bars[i].v || 0) > avg * mult;
      }
      break;
    }

    case "higher_high": {
      const win = cond.params.window || 5;
      for (let i = win; i < n - win; i++) {
        const peak = Math.max(...bars.slice(i - win, i + win + 1).map(b => b.h));
        result[i] = bars[i].h === peak;
      }
      break;
    }

    case "lower_low": {
      const win = cond.params.window || 5;
      for (let i = win; i < n - win; i++) {
        const trough = Math.min(...bars.slice(i - win, i + win + 1).map(b => b.l));
        result[i] = bars[i].l === trough;
      }
      break;
    }

    // ── Trend-regime filters ────────────────────────────────────────────────
    // ema_slope_up: EMA(period) is rising over `lookback` bars → uptrend regime
    case "ema_slope_up": {
      const period   = cond.params.period   || 21;
      const lookback = cond.params.lookback || 3;
      const ema = derived[`ema_${period}`] || calcEMA(bars.map(b => b.c), period);
      for (let i = lookback; i < n; i++)
        result[i] = ema[i] != null && ema[i - lookback] != null && ema[i] > ema[i - lookback];
      break;
    }

    // ema_slope_down: EMA(period) is falling → downtrend regime
    case "ema_slope_down": {
      const period   = cond.params.period   || 21;
      const lookback = cond.params.lookback || 3;
      const ema = derived[`ema_${period}`] || calcEMA(bars.map(b => b.c), period);
      for (let i = lookback; i < n; i++)
        result[i] = ema[i] != null && ema[i - lookback] != null && ema[i] < ema[i - lookback];
      break;
    }

    // adx_trending: ADX(period) >= threshold → strong trend, not ranging/chop
    case "adx_trending": {
      const period    = cond.params.period    || 14;
      const threshold = cond.params.threshold || 25;
      const adxArr = calcADX(bars, period);
      for (let i = 0; i < n; i++)
        result[i] = adxArr[i] != null && adxArr[i] >= threshold;
      break;
    }

    // ── Regime gate ─────────────────────────────────────────────────────────
    // regime_tradeable: bar must be in a tradeable regime (not ranging or chaos)
    // Uses RegimeEngine.classifyRegimes internally; result cached on derived.
    case "regime_tradeable": {
      const direction = cond.params.direction || null; // null = either direction
      let regimes = derived._regimes;
      if (!regimes) {
        const rc = classifyRegimes(bars, {
          adxPeriod:         cond.params.adx_period    || 14,
          adxTrendThreshold: cond.params.adx_threshold || 22,
        });
        derived._regimes = rc.regimes;
        regimes = rc.regimes;
      }
      for (let i = 0; i < n; i++)
        result[i] = isTradeable(regimes[i], direction);
      break;
    }

    // ── Volatility / fee-clearance gate ────────────────────────────────────
    // forecast_clears_fees: ATR/price must be large enough to overcome fees
    // at the configured R:R.  Suppresses low-magnitude signals.
    case "forecast_clears_fees": {
      const atrPeriod = cond.params.atr_period || 14;
      const feeRtPct  = cond.params.fee_rt_pct || 0.65;  // round-trip fee %
      const rrRatio   = cond.params.rr_ratio   || 2.0;
      const margin    = cond.params.margin      || 2.0;   // safety multiplier
      const required  = feeRtPct * rrRatio * margin;      // % move needed
      const atrArr    = derived[`atr_${atrPeriod}`] || calcATR(bars, atrPeriod);
      derived[`atr_${atrPeriod}`] = atrArr;
      for (let i = 0; i < n; i++) {
        const price  = bars[i]?.c;
        const atr    = atrArr[i];
        if (!price || !atr) continue;
        result[i] = (atr / price * 100) >= required;
      }
      break;
    }

    // ── High-volatility breakout gate ───────────────────────────────────────
    // atr_breakout: current ATR > multiplier × average ATR over lookback bars.
    // Favours high-momentum setups where the expected move is large enough to
    // absorb round-trip fees.  Treated as a gate — only added via pass3b.
    case "atr_breakout": {
      const period   = cond.params.period     ?? 14;
      const mult     = cond.params.multiplier ?? 1.5;
      const lookback = cond.params.lookback   ?? 20;
      const atrArr   = derived[`atr_${period}`] || calcATR(bars, period);
      derived[`atr_${period}`] = atrArr;
      for (let i = lookback; i < n; i++) {
        if (atrArr[i] == null) continue;
        let sum = 0, cnt = 0;
        for (let j = Math.max(0, i - lookback); j < i; j++) {
          if (atrArr[j] != null) { sum += atrArr[j]; cnt++; }
        }
        if (cnt === 0) continue;
        result[i] = atrArr[i] > (sum / cnt) * mult;
      }
      break;
    }

    // ── Volume + ATR expansion gate ──────────────────────────────────────────
    // vol_expansion: volume spike AND ATR in the upper percentile of its
    // lookback range.  Confirms volume is correlated with directional movement.
    // Treated as a gate — only added via pass3b.
    case "vol_expansion": {
      const volMult      = cond.params.vol_multiplier    ?? 1.5;
      const atrPeriod    = cond.params.atr_period        ?? 14;
      const atrPctThresh = cond.params.atr_pct_threshold ?? 65;
      const lookback     = cond.params.lookback          ?? 20;
      const atrArr       = derived[`atr_${atrPeriod}`] || calcATR(bars, atrPeriod);
      derived[`atr_${atrPeriod}`] = atrArr;
      for (let i = lookback; i < n; i++) {
        if (atrArr[i] == null) continue;
        // Volume component
        let sumV = 0;
        for (let j = Math.max(0, i - lookback); j < i; j++) sumV += (bars[j].v || 0);
        const avgVol = sumV / Math.min(lookback, i);
        if (!((bars[i].v || 0) > avgVol * volMult)) continue; // fast path
        // ATR percentile component
        let below = 0, total = 0;
        for (let j = Math.max(0, i - lookback); j < i; j++) {
          if (atrArr[j] != null) { if (atrArr[j] <= atrArr[i]) below++; total++; }
        }
        if (total < 5) continue;
        result[i] = (below / total) * 100 >= atrPctThresh;
      }
      break;
    }

    // ── Pivot-point conditions ─────────────────────────────────────────────────
    // price_above_pivot: close > chosen level (e.g. R1) from prior period.
    // level: 'pp'|'r1'|'r2'|'r3'|'r4'|'s1'|'s2'|'s3'|'s4'
    // type:  'classic'|'woodie'|'camarilla'
    // period_hours: bucket width for pivot calculation (default 24)
    case "price_above_pivot": {
      const pType   = cond.params.type         || 'classic';
      const pHours  = cond.params.period_hours || 24;
      const pLevel  = cond.params.level        || 'r1';
      const pivots  = calcPivotPoints(bars, pType, pHours);
      for (let i = 0; i < n; i++) {
        if (!pivots[i]) continue;
        const lvl = pivots[i][pLevel];
        result[i] = lvl != null && bars[i].c > lvl;
      }
      break;
    }

    // price_below_pivot: close < chosen level (e.g. S1).
    case "price_below_pivot": {
      const pType   = cond.params.type         || 'classic';
      const pHours  = cond.params.period_hours || 24;
      const pLevel  = cond.params.level        || 's1';
      const pivots  = calcPivotPoints(bars, pType, pHours);
      for (let i = 0; i < n; i++) {
        if (!pivots[i]) continue;
        const lvl = pivots[i][pLevel];
        result[i] = lvl != null && bars[i].c < lvl;
      }
      break;
    }

    // price_near_pivot: |close - level| <= tolerance × ATR.
    // Detects price touching a pivot zone — ideal for mean-reversion entries.
    // tolerance: ATR multiplier defining the “zone” width (default 0.5)
    case "price_near_pivot": {
      const pType   = cond.params.type         || 'classic';
      const pHours  = cond.params.period_hours || 24;
      const pLevel  = cond.params.level        || 's3';
      const tol     = cond.params.tolerance    || 0.5;
      const atrP    = cond.params.atr_period   || 14;
      const pivots  = calcPivotPoints(bars, pType, pHours);
      const atrArr  = derived[`atr_${atrP}`] || calcATR(bars, atrP);
      derived[`atr_${atrP}`] = atrArr;
      for (let i = 0; i < n; i++) {
        if (!pivots[i] || !atrArr[i]) continue;
        const lvl = pivots[i][pLevel];
        result[i] = lvl != null && Math.abs(bars[i].c - lvl) <= tol * atrArr[i];
      }
      break;
    }

    // ── Bollinger Band squeeze ─────────────────────────────────────────────
    // bb_squeeze: fires when current BB width is narrower than pct × rolling
    // average width.  Identifies volatility compression before breakouts. 
    // Pair with a directional condition (e.g. ema_slope_up) to trade the
    // expansion phase rather than the squeeze itself.
    case "bb_squeeze": {
      const period   = cond.params.period   ?? 20;
      const k        = cond.params.k        ?? 2;
      const lookback = cond.params.lookback ?? 20;
      const sqzPct   = cond.params.pct      ?? 0.5;  // width < sqzPct × lookback-avg
      const bb       = _calcBB(bars, period, k);
      for (let i = lookback + period; i < n; i++) {
        if (bb.upper[i] == null || bb.lower[i] == null) continue;
        const width = bb.upper[i] - bb.lower[i];
        let sumW = 0, cntW = 0;
        for (let j = i - lookback; j < i; j++) {
          if (bb.upper[j] != null && bb.lower[j] != null) {
            sumW += bb.upper[j] - bb.lower[j]; cntW++;
          }
        }
        if (cntW === 0) continue;
        result[i] = width < (sumW / cntW) * sqzPct;
      }
      break;
    }

    // ── ADX above threshold (explicit directness alias for adx_trending) ──
    // adx_above: ADX ≥ threshold.  Identical logic to adx_trending but
    // semantic name makes the intent clearer in multi-condition descriptions.
    case "adx_above": {
      const period    = cond.params.period    ?? 14;
      const threshold = cond.params.threshold ?? 25;
      const adxArr    = calcADX(bars, period);
      for (let i = 0; i < n; i++)
        result[i] = adxArr[i] != null && adxArr[i] >= threshold;
      break;
    }

    // ── Direction-specific regime gate ────────────────────────────────────
    // regime_is: passes when the current regime matches the requested direction.
    //   direction='bull' → trending_bull only
    //   direction='bear' → trending_bear only
    //   direction=null   → any tradeable regime (equivalent to regime_tradeable)
    case "regime_is": {
      const reqDir = cond.params.direction ?? null;
      let regimes  = derived._regimes;
      if (!regimes) {
        const rc = classifyRegimes(bars, {
          adxPeriod:         cond.params.adx_period    ?? 14,
          adxTrendThreshold: cond.params.adx_threshold ?? 22,
        });
        derived._regimes = rc.regimes;
        regimes          = rc.regimes;
      }
      for (let i = 0; i < n; i++) {
        if (!regimes[i]) continue;
        if      (reqDir === 'bull') result[i] = regimes[i] === 'trending_bull';
        else if (reqDir === 'bear') result[i] = regimes[i] === 'trending_bear';
        else                        result[i] = isTradeable(regimes[i], null);
      }
      break;
    }

    default:
      break;
  }

  return result;
}

// Intraday VWAP (resets each UTC day)
function _buildVWAP(bars) {
  const out   = new Array(bars.length).fill(null);
  let cumPV   = 0, cumV = 0, lastDay = -1;
  for (let i = 0; i < bars.length; i++) {
    const day = Math.floor(bars[i].t / 86400000);
    if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const v  = bars[i].v || 1;
    cumPV += tp * v;
    cumV  += v;
    out[i]  = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

// Internal Bollinger Band helper (upper, mid, lower arrays)
function _calcBB(bars, period = 20, k = 2) {
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  const mid   = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].c;
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (bars[j].c - mean) ** 2;
    const std = Math.sqrt(v / period);
    mid[i]   = mean;
    upper[i] = mean + k * std;
    lower[i] = mean - k * std;
  }
  return { upper, mid, lower };
}

// ─── Main scan ───────────────────────────────────────────────────────────────

/**
 * Run the full signal scan over bars[] using the given strategy config.
 *
 * @param {object[]} bars         – candle array {t,o,h,l,c,v?}
 * @param {object}   strategy     – strategy config (same schema as JSON export)
 * @param {object}   [derived]    – optional pre-computed indicator cache
 * @param {object}   [qualityOpts] – optional SQS gate options:
 *   { enabled, minSQS, feeRtPct, rrRatio, htfBars, edgeCache, autoRecord }
 * @returns {{ signals, trades, stats }}
 */
export function runSignalScan(bars, strategy, derived = {}, qualityOpts = {}) {
  if (!bars || bars.length < 2) return { signals: [], trades: [], stats: emptyStats() };

  const { entry, exit, risk } = strategy;
  const closes = bars.map(b => b.c);

  // ── Pre-compute regime once for the whole bar series ─────────────────────
  const sqsEnabled = qualityOpts?.enabled === true;
  let regimeResult = null;
  if (sqsEnabled) {
    regimeResult = derived._regimeResult ||
      classifyRegimes(bars, { adxPeriod: 14, adxTrendThreshold: 22 });
    derived._regimeResult = regimeResult;
  }

  // ── Evaluate each active entry condition ─────────────────────────────────
  const activeConditions = entry.conditions.filter(c => c.enabled !== false);
  const condMasks = activeConditions.map(c => evalCondition(c, bars, derived));

  // ── Combine with AND / OR logic ──────────────────────────────────────────
  const n = bars.length;
  const entryMask = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (condMasks.length === 0) break;
    entryMask[i] = entry.logic === "OR"
      ? condMasks.some(m => m[i])
      : condMasks.every(m => m[i]);
  }

  // ── Compute ATR for stop/target sizing ────────────────────────────────────
  const atrArr = calcATR(bars, exit.stop_loss?.params?.period || 14);

  // ── Walk bars and place signals + trades (no overlapping positions) ───────
  const signals = [];
  const trades  = [];
  let   inTrade = false;
  let   tradeOpen = null;

  for (let i = 1; i < n; i++) {
    if (!inTrade && entryMask[i]) {
      const atr   = atrArr[i] || (bars[i].h - bars[i].l);
      const price = bars[i].c;

      // Stop / target
      let stopDist, stop, target, rr;
      if (exit.stop_loss?.type === "atr") {
        stopDist = atr * (exit.stop_loss.params?.multiplier || 2);
      } else if (exit.stop_loss?.type === "pct") {
        stopDist = price * (exit.stop_loss.params?.pct || 1) / 100;
      } else {
        stopDist = atr * 2;
      }

      if (entry.direction === "long") {
        stop   = price - stopDist;
        const rrRatio = exit.take_profit?.ratio || 2;
        target = price + stopDist * rrRatio;
        rr     = rrRatio;
      } else {
        stop   = price + stopDist;
        const rrRatio = exit.take_profit?.ratio || 2;
        target = price - stopDist * rrRatio;
        rr     = rrRatio;
      }

      // Position size
      const accountSize = risk?.account_size    || 10000;
      const riskPct     = risk?.risk_per_trade_pct || 1.0;
      const riskDollar  = accountSize * riskPct / 100;
      const qty         = stopDist > 0 ? riskDollar / stopDist : 0;

      // ── SQS gate — only enter when signal quality clears threshold ─────
      const condIds = activeConditions.map(c => c.id);
      if (sqsEnabled) {
        const sqs = computeSQS(bars, i, entry.direction, condIds, regimeResult, {
          rrRatio:   exit.take_profit?.ratio ?? 2.0,
          feeRtPct:  qualityOpts.feeRtPct  ?? ((strategy.fees?.entry_pct ?? 0) + (strategy.fees?.exit_pct ?? 0)),
          atrPeriod: exit.stop_loss?.params?.period ?? 14,
          edgeCache: qualityOpts.edgeCache ?? globalEdgeCache,
          htfBars:   qualityOpts.htfBars  ?? null,
          minSQS:    qualityOpts.minSQS   ?? 55,
        });
        if (!sqs.passes) continue;  // skip low-quality signal
      }

      const sig = {
        id:        `sig_${i}`,
        t:         bars[i].t,
        barIdx:    i,
        price,
        direction: entry.direction,
        stop,
        target,
        rr,
        stopDist,
        qty:       +qty.toFixed(6),
        atr,
        condsFired: condIds,
        regime:    regimeResult ? regimeResult.regimes[i] : null,
      };
      signals.push(sig);

      inTrade  = true;
      tradeOpen = { ...sig, entryIdx: i };
      continue;
    }

    if (inTrade && tradeOpen) {
      const bar   = bars[i];
      const isLong = tradeOpen.direction === "long";
      const maxBars = exit.max_bars || 48;
      const barsHeld = i - tradeOpen.entryIdx;

      // Exit conditions: hit stop, hit target, or max bars
      const hitStop   = isLong ? bar.l <= tradeOpen.stop   : bar.h >= tradeOpen.stop;
      const hitTarget = isLong ? bar.h >= tradeOpen.target : bar.l <= tradeOpen.target;
      const expiry    = barsHeld >= maxBars;

      if (hitStop || hitTarget || expiry) {
        let exitPrice, exitReason;
        if (hitTarget) { exitPrice = tradeOpen.target; exitReason = "tp"; }
        else if (hitStop) { exitPrice = tradeOpen.stop; exitReason = "sl"; }
        else { exitPrice = bar.c; exitReason = "expiry"; }

        const pnlPts     = isLong ? exitPrice - tradeOpen.price : tradeOpen.price - exitPrice;
        const grossUSD   = pnlPts * tradeOpen.qty;

        // ── Fee deduction ────────────────────────────────────────────────
        const feeEntryPct = (strategy.fees?.entry_pct ?? 0) / 100;
        const feeExitPct  = (strategy.fees?.exit_pct  ?? 0) / 100;
        const entryFeeUSD = tradeOpen.price * tradeOpen.qty * feeEntryPct;
        const exitFeeUSD  = exitPrice       * tradeOpen.qty * feeExitPct;
        const feesUSD     = entryFeeUSD + exitFeeUSD;
        const pnlUSD      = grossUSD - feesUSD;
        const pnlRR       = pnlPts / tradeOpen.stopDist;

        const trade = {
          entryT:     tradeOpen.t,
          exitT:      bar.t,
          entryPrice: tradeOpen.price,
          exitPrice,
          direction:  tradeOpen.direction,
          qty:        tradeOpen.qty,
          pnlPts:     +pnlPts.toFixed(6),
          grossUSD:   +grossUSD.toFixed(2),
          feesUSD:    +feesUSD.toFixed(2),
          pnlUSD:     +pnlUSD.toFixed(2),
          pnlRR:      +pnlRR.toFixed(2),
          barsHeld,
          exitReason,
          stop:       tradeOpen.stop,
          target:     tradeOpen.target,
          regime:     tradeOpen.regime ?? null,
          condsFired: tradeOpen.condsFired ?? [],
        };
        trades.push(trade);

        // Feed result back into EdgeCache for ongoing Bayesian learning
        if (sqsEnabled && (qualityOpts.autoRecord !== false)) {
          recordTrade(
            trade,
            tradeOpen.condsFired ?? [],
            tradeOpen.regime,
            qualityOpts.edgeCache ?? globalEdgeCache
          );
        }

        inTrade   = false;
        tradeOpen = null;
      }
    }
  }

  const stats = computeTradeStats(trades);
  return { signals, trades, stats };
}

// ─── Statistics ──────────────────────────────────────────────────────────────

export function computeTradeStats(trades) {
  if (!trades.length) return emptyStats();

  const wins      = trades.filter(t => t.pnlUSD > 0);
  const losses    = trades.filter(t => t.pnlUSD <= 0);
  const grossWin  = wins.reduce((s, t)  => s + t.pnlUSD, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlUSD), 0);
  const totalFees = trades.reduce((s, t) => s + (t.feesUSD ?? 0), 0);
  const grossPnl  = trades.reduce((s, t) => s + (t.grossUSD ?? t.pnlUSD), 0);

  // Equity curve for drawdown
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlUSD;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    total:            trades.length,
    wins:             wins.length,
    losses:           losses.length,
    win_rate:         +(wins.length / trades.length * 100).toFixed(1),
    avg_rr:           +(trades.reduce((s, t) => s + t.pnlRR, 0) / trades.length).toFixed(2),
    profit_factor:    grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    net_pnl_usd:      +trades.reduce((s, t) => s + t.pnlUSD, 0).toFixed(2),
    gross_pnl_usd:    +grossPnl.toFixed(2),
    total_fees_usd:   +totalFees.toFixed(2),
    max_drawdown_usd: +maxDD.toFixed(2),
    avg_bars_held:    +(trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length).toFixed(1),
    tp_pct:  +(trades.filter(t => t.exitReason === "tp").length / trades.length * 100).toFixed(1),
    sl_pct:  +(trades.filter(t => t.exitReason === "sl").length / trades.length * 100).toFixed(1),
    exp_pct: +(trades.filter(t => t.exitReason === "expiry").length / trades.length * 100).toFixed(1),
  };
}

function emptyStats() {
  return {
    total: 0, wins: 0, losses: 0, win_rate: 0,
    avg_rr: 0, profit_factor: null, net_pnl_usd: 0,
    gross_pnl_usd: 0, total_fees_usd: 0,
    max_drawdown_usd: 0, avg_bars_held: 0,
    tp_pct: 0, sl_pct: 0, exp_pct: 0,
  };
}

// ─── Default strategy template ───────────────────────────────────────────────

export function defaultStrategy(symbol = "UNKNOWN", timeframe = "15m") {
  return {
    schema_version: "1.0",
    meta: {
      name:      `${symbol} Momentum Long`,
      symbol,
      timeframe,
      created:   new Date().toISOString(),
      notes:     "",
    },
    entry: {
      direction: "long",
      logic:     "AND",
      confirm_bars: 1,
      conditions: [
        { id: "ema_cross_up",    enabled: true,  params: { fast: 9, slow: 21 },
          label: "EMA 9 crosses above EMA 21" },
        { id: "macd_hist_pos",   enabled: true,  params: { fast: 12, slow: 26, sig: 9 },
          label: "MACD histogram turns positive" },
        { id: "rsi_in_zone",     enabled: true,  params: { period: 14, min: 40, max: 65 },
          label: "RSI 40–65 (not exhausted)" },
        { id: "price_above_vwap",enabled: false, params: {},
          label: "Price above intraday VWAP" },
        { id: "volume_spike",    enabled: false, params: { multiplier: 1.5 },
          label: "Volume spike (1.5× avg)" },
        { id: "ema_above_slow",  enabled: false, params: { fast: 21, slow: 200 },
          label: "EMA 21 > EMA 200 (trend filter)" },
      ],
    },
    exit: {
      stop_loss:   { type: "atr",  params: { period: 14, multiplier: 2.0 } },
      take_profit: { type: "rr",   ratio: 2.5 },
      max_bars:    48,
    },
    risk: {
      method:               "fixed_pct",
      account_size:         1000,
      risk_per_trade_pct:   1.0,
      max_open_positions:   1,
      max_drawdown_pct:     10.0,
    },
    // Kraken Pro starter tier defaults (taker entry, maker exit)
    fees: {
      exchange:   "Kraken Pro",
      entry_pct:  0.40,   // taker — market order at entry
      exit_pct:   0.25,   // maker — limit TP/SL orders
    },
    backtest_summary: null,
  };
}

// ─── JSON import/export helpers ──────────────────────────────────────────────

export function exportStrategyJSON(strategy, stats) {
  const out = JSON.parse(JSON.stringify(strategy));
  out.meta.exported = new Date().toISOString();
  out.backtest_summary = stats || null;
  return JSON.stringify(out, null, 2);
}

export function importStrategyJSON(jsonStr) {
  const obj = JSON.parse(jsonStr);
  if (!obj.schema_version || !obj.entry || !obj.exit) {
    throw new Error("Invalid strategy schema — missing required fields");
  }
  return obj;
}

// ─── Built-in Pivot Strategies ────────────────────────────────────────────────
// Moved to src/optimizer/PivotStrategies.js — re-exported here for backward
// compatibility with any existing imports from SignalEngine.
// New code should import directly from '../optimizer/PivotStrategies.js'.
export { getPivotStrategies } from '../optimizer/PivotStrategies.js';

// Below: legacy function body kept as dead code so git history is preserved.
// DO NOT call — the export above shadows it. Will be removed in a future cleanup.
function _getPivotStrategies_DEPRECATED() {
  const fees = { exchange: "Kraken Pro", entry_pct: 0.40, exit_pct: 0.25 };
  const risk = { method: "fixed_pct", account_size: 1000, risk_per_trade_pct: 1.0,
                 max_open_positions: 1, max_drawdown_pct: 10.0 };
  const meta = (name, notes = "") => ({
    schema_version: "1.0",
    meta: { name, symbol: "UNKNOWN", timeframe: "15m",
            created: new Date().toISOString(), notes },
  });

  return [
    // ── 1: Classic Pivot Breakout Long ──────────────────────────────────────────────────
    {
      ...meta("Pivot: Classic R1 Breakout Long",
              "Close clears prev-24h R1 on volume surge with trend confirmation"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "r1" },
            label: "Close > Daily R1 (classic pivot)" },
          { id: "volume_spike", enabled: true, params: { multiplier: 1.5 },
            label: "Volume spike 1.5× avg" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 22 },
            label: "ADX ≥ 22 (trend confirmed)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.8 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 64 },
      risk, fees,
    },

    // ── 2: Classic Pivot Breakout Short ───────────────────────────────────────────────
    {
      ...meta("Pivot: Classic S1 Breakdown Short",
              "Close breaks below prev-24h S1 with volume and trend confirmation"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_below_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s1" },
            label: "Close < Daily S1 (classic pivot)" },
          { id: "volume_spike",  enabled: true, params: { multiplier: 1.5 },
            label: "Volume spike 1.5×" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 22 },
            label: "ADX ≥ 22" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.8 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 64 },
      risk, fees,
    },

    // ── 3: Camarilla Mean-Reversion Long ──────────────────────────────────────────────
    {
      ...meta("Pivot: Camarilla S3 Mean-Reversion Long",
              "Touch of S3 Camarilla level with RSI oversold — crypto bounce play"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "camarilla", period_hours: 24, level: "s3", tolerance: 0.5 },
            label: "Price near Camarilla S3 (±0.5 ATR)" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 20, max: 38 },
            label: "RSI oversold zone (20–38)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },

    // ── 4: Camarilla Mean-Reversion Short ─────────────────────────────────────────────
    {
      ...meta("Pivot: Camarilla R3 Mean-Reversion Short",
              "Price stalls at R3 Camarilla with overbought RSI — crypto rejection play"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "camarilla", period_hours: 24, level: "r3", tolerance: 0.5 },
            label: "Price near Camarilla R3 (±0.5 ATR)" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 62, max: 80 },
            label: "RSI overbought zone (62–80)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },

    // ── 5: Woodie Pivot PP Bounce Long ────────────────────────────────────────────────
    {
      ...meta("Pivot: Woodie PP Bounce Long",
              "Price holds above Woodie PP with EMA trend aligned — momentum continuation"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "woodie", period_hours: 24, level: "pp" },
            label: "Close > Woodie PP" },
          { id: "ema_above_slow", enabled: true, params: { fast: 9, slow: 21 },
            label: "EMA 9 > EMA 21" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 45, max: 65 },
            label: "RSI 45–65" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.5 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 48 },
      risk, fees,
    },

    // ── 6: Vol Expansion Breakout Long ───────────────────────────────────────────────
    {
      ...meta("Pivot: Vol Expansion Breakout Long",
              "ATR expanding + close above R1 + ADX: high-conviction breakout for crypto"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "r1" },
            label: "Close > Daily R1" },
          { id: "atr_breakout",  enabled: true,
            params: { period: 14, multiplier: 1.5, lookback: 20 },
            label: "ATR expanding (breakout momentum)" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 25 },
            label: "ADX ≥ 25" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 72 },
      risk, fees,
    },

    // ── 7: Vol Expansion Breakdown Short ──────────────────────────────────────────────
    {
      ...meta("Pivot: Vol Expansion Breakdown Short",
              "ATR expanding + close below S1 + ADX: high-conviction breakdown"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_below_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s1" },
            label: "Close < Daily S1" },
          { id: "atr_breakout",  enabled: true,
            params: { period: 14, multiplier: 2.0, lookback: 20 },
            label: "ATR expanding (breakdown momentum)" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 25 },
            label: "ADX ≥ 25" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 72 },
      risk, fees,
    },

    // ── 8: Classic Pivot Zone Mean-Reversion Long ─────────────────────────────────
    {
      ...meta("Pivot: Classic S2 Zone Bounce Long",
              "Price pinches S2 on RSI exhaustion + MACD turn — bounce toward PP"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s2", tolerance: 0.6 },
            label: "Price near Classic S2 (±0.6 ATR)" },
          { id: "rsi_oversold",  enabled: true, params: { period: 14, level: 30 },
            label: "RSI crosses above 30" },
          { id: "macd_hist_pos", enabled: true, params: { fast: 12, slow: 26, sig: 9 },
            label: "MACD hist turns positive" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },
  ];
}
