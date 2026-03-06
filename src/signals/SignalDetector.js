/**
 * SignalDetector
 * Scans price / indicator data and emits candidate events for AI labelling.
 *
 * Signals detected:
 *  - MACD histogram sign change (zero-line cross)
 *  - EMA9 × EMA21 cross on the close price
 *  - Volume spike (volume > 2.5× 20-bar rolling average)
 */

function ema(values, period) {
  // Seed with SMA of the first `period` bars so the line starts at the
  // correct price level with zero warm-up ramp. Indices 0..period-2 are
  // null so they're never drawn, eliminating any diagonal artifact.
  const k   = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

export function detectSignals(bars, macdData, volumeArr) {
  const events = [];

  /* ── 1. MACD histogram zero-line cross ────────────────────── */
  for (let i = 1; i < macdData.length; i++) {
    const prev = macdData[i - 1];
    const curr = macdData[i];
    if (prev.hist < 0 && curr.hist >= 0) {
      events.push({
        id:     `macd_bull_${i}`,
        t:      curr.t,
        kind:   "buy",
        source: "macd_cross",
        label:  "MACD↑",
        stage:  "ensemble",
        context: { macd_hist: curr.hist, macd: curr.macd, signal: curr.signal },
      });
    } else if (prev.hist >= 0 && curr.hist < 0) {
      events.push({
        id:     `macd_bear_${i}`,
        t:      curr.t,
        kind:   "sell",
        source: "macd_cross",
        label:  "MACD↓",
        stage:  "ensemble",
        context: { macd_hist: curr.hist, macd: curr.macd, signal: curr.signal },
      });
    }
  }

  /* ── 2. EMA 9 / 21 golden + death cross ──────────────────── */
  if (bars.length > 25) {
    const closes = bars.map(b => b.c);
    const e9  = ema(closes, 9);
    const e21 = ema(closes, 21);

    for (let i = 22; i < bars.length; i++) {
      if (e9[i-1] == null || e21[i-1] == null || e9[i] == null || e21[i] == null) continue;
      const prevDiff = e9[i - 1] - e21[i - 1];
      const currDiff = e9[i]     - e21[i];
      if (prevDiff < 0 && currDiff >= 0) {
        events.push({
          id:     `ema_bull_${i}`,
          t:      bars[i].t,
          kind:   "buy",
          source: "ema_cross",
          label:  "EMA×",
          stage:  "ensemble",
          context: { ema9: e9[i], ema21: e21[i], close: bars[i].c },
        });
      } else if (prevDiff >= 0 && currDiff < 0) {
        events.push({
          id:     `ema_bear_${i}`,
          t:      bars[i].t,
          kind:   "sell",
          source: "ema_cross",
          label:  "EMA×",
          stage:  "ensemble",
          context: { ema9: e9[i], ema21: e21[i], close: bars[i].c },
        });
      }
    }
  }

  /* ── 3. Volume spike: vol > 2.5× 20-bar SMA ─────────────── */
  if (volumeArr && volumeArr.length > 20) {
    const vols = volumeArr.map(v => v.v ?? 0);
    const sma20 = sma(vols, 20);

    for (let i = 20; i < volumeArr.length; i++) {
      if (sma20[i] == null || sma20[i] === 0) continue;
      const ratio = vols[i] / sma20[i];
      if (ratio >= 2.5) {
        // Find corresponding bar for price direction
        const barIdx = bars.findIndex(b => b.t === volumeArr[i].t);
        const kind   = barIdx >= 0 && bars[barIdx].c > bars[barIdx].o ? "buy" : "sell";
        events.push({
          id:     `vol_spike_${i}`,
          t:      volumeArr[i].t,
          kind,
          source: "vol_spike",
          label:  `Vol×${ratio.toFixed(1)}`,
          stage:  "ensemble",
          context: { vol_ratio: ratio, vol: vols[i] },
        });
      }
    }
  }

  return events;
}

/** Compute EMA arrays aligned with bars[] for overlay rendering.
 *  First (period-1) values are null so no warm-up artifact is drawn. */
export function computeEmas(bars) {
  if (bars.length < 2) return { ema9: [], ema21: [] };
  const closes = bars.map(b => b.c);
  return { ema9: ema(closes, 9), ema21: ema(closes, 21) };
}
