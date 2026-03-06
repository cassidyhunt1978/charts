/**
 * Aggregator.js
 * Resamples 1-minute base bars into larger timeframes.
 * Input: bars[] sorted ascending by t (milliseconds).
 */

export const TF_MINUTES = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "4h": 240,
  "1D": 1440, "1d": 1440,
  "1W": 10080, "1w": 10080,
};

export function tfToMinutes(tf) {
  // accept both upper and lower case ("1D" / "1d", "1W" / "1w")
  return TF_MINUTES[tf] ?? TF_MINUTES[tf?.toUpperCase()] ?? TF_MINUTES[tf?.toLowerCase()] ?? 1;
}

/**
 * Resample OHLC bars to larger timeframe.
 * @param {object[]} bars     [{t,o,h,l,c}, …] sorted ascending
 * @param {number}   tfMin    target timeframe in minutes
 * @returns {object[]}
 */
export function resample(bars, tfMin) {
  if (tfMin <= 1 || !bars.length) return bars;
  const ms = tfMin * 60_000;
  const buckets = new Map();

  for (const b of bars) {
    const key = Math.floor(b.t / ms) * ms;
    const bk  = buckets.get(key);
    if (!bk) {
      buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 });
    } else {
      bk.h  = Math.max(bk.h, b.h);
      bk.l  = Math.min(bk.l, b.l);
      bk.c  = b.c;
      bk.v  = (bk.v ?? 0) + (b.v ?? 0);
    }
  }

  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/**
 * Resample volume array aligned with base bars.
 * @param {object[]} volumeArr [{t,v}, …] sorted ascending
 * @param {number}   tfMin
 * @returns {object[]}
 */
export function resampleVolume(volumeArr, tfMin) {
  if (tfMin <= 1 || !volumeArr.length) return volumeArr;
  const ms = tfMin * 60_000;
  const buckets = new Map();

  for (const v of volumeArr) {
    const key = Math.floor(v.t / ms) * ms;
    const cur = buckets.get(key);
    buckets.set(key, { t: key, v: (cur?.v ?? 0) + (v.v ?? 0) });
  }

  return [...buckets.values()].sort((a, b) => a.t - b.t);
}
