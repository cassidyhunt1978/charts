/**
 * indicators.js
 * RSI, Bollinger Bands, VWAP — all aligned with bars[].
 */

// ── RSI ──────────────────────────────────────────────────────────────────────
/**
 * @param {object[]} bars   [{c, …}, …]
 * @param {number}   period default 14
 * @returns {(number|null)[]}  null during warmup
 */
export function computeRSI(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  out[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    avgGain = (avgGain * (period - 1) + Math.max(0,  d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────
/**
 * @param {object[]} bars
 * @param {number}   period  default 20
 * @param {number}   k       std-dev multiplier, default 2
 * @returns {{ upper:(number|null)[], mid:(number|null)[], lower:(number|null)[] }}
 */
export function computeBollinger(bars, period = 20, k = 2) {
  const upper  = new Array(bars.length).fill(null);
  const mid    = new Array(bars.length).fill(null);
  const lower  = new Array(bars.length).fill(null);

  for (let i = period - 1; i < bars.length; i++) {
    const slice  = bars.slice(i - period + 1, i + 1);
    const mean   = slice.reduce((s, b) => s + b.c, 0) / period;
    const variance = slice.reduce((s, b) => s + (b.c - mean) ** 2, 0) / period;
    const std    = Math.sqrt(variance);
    mid[i]   = mean;
    upper[i] = mean + k * std;
    lower[i] = mean - k * std;
  }

  return { upper, mid, lower };
}

// ── VWAP (resets at 00:00 UTC daily) ─────────────────────────────────────────
/**
 * @param {object[]} bars    [{t,h,l,c}, …]
 * @param {object[]} volume  [{t,v}, …] aligned index-for-index with bars
 * @returns {(number|null)[]}
 */
export function computeVWAP(bars, volume) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0, cumV = 0, lastDay = -1;

  for (let i = 0; i < bars.length; i++) {
    const day = Math.floor(bars[i].t / 86_400_000);
    if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
    const typical = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const vol     = volume[i]?.v ?? 0;
    cumPV += typical * vol;
    cumV  += vol;
    out[i] = cumV > 0 ? cumPV / cumV : typical;
  }
  return out;
}

// ── EMA / ATR / ADX — exported here to avoid circular imports ────────────────
// (SignalEngine.js also defines and exports these; RegimeEngine + SignalQuality
// must import from THIS file rather than from SignalEngine to break the cycle.)

/** Exponential Moving Average over a price array. */
export function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] == null) continue;
    if (out[i - 1] == null) {
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

/** Average Directional Index — trend strength (>25 = trending). */
export function calcADX(bars, period = 14) {
  const n = bars.length;
  const adx = new Array(n).fill(null);
  if (n < period * 2 + 1) return adx;

  const tr = new Array(n).fill(0);
  const dmP = new Array(n).fill(0);
  const dmM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    const ph = bars[i - 1].h, pl = bars[i - 1].l;
    tr[i]  = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph, dn = pl - l;
    dmP[i] = (up > dn && up > 0) ? up : 0;
    dmM[i] = (dn > up && dn > 0) ? dn : 0;
  }

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
