function ema(values, period) {
  const k = 2 / (period + 1);
  let out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// Mock provider generates:
// - bars (OHLC)
// - volume
// - macd (hist, macd, signal)
export async function mockProvider() {
  const bars = [];
  const volume = [];
  const markers = [];
  const events = [];
  const positions = [];

  const now = Date.now();
  const start = now - 3 * 24 * 60 * 60 * 1000; // 3 days
  let price = 100;

  for (let i = 0; i < 6000; i++) {
    const t = start + i * 60_000;
    const drift = Math.sin(i / 180) * 0.15;
    const noise = (Math.random() - 0.5) * 0.9;

    const o = price;
    const c = price + drift + noise;
    const h = Math.max(o, c) + Math.random() * 0.6;
    const l = Math.min(o, c) - Math.random() * 0.6;

    const v = 100 + Math.random() * 220;

    bars.push({ t, o, h, l, c });
    volume.push({ t, v });

    // Ensemble signals every ~120 bars; user-lane markers every ~300 bars
    if (i % 120 === 0 && i > 0) {
      const kind = (Math.sin(i / 240) > 0) ? "buy" : "sell";
      events.push({
        id: `e_${i}`,
        t,
        kind,
        stage: "ensemble",
        label: kind === "buy" ? "Long" : "Short",
      });
    }
    if (i % 300 === 0 && i > 0) {
      const kind = (i % 600 === 0) ? "buy" : "sell";
      markers.push({ id: `m_${i}`, t, kind, pane: "lane" });
    }

    price = c;
  }

  // MACD from closes
  const closes = bars.map(b => b.c);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macdLine, 9);
  const macd = macdLine.map((m, i) => ({
    t: bars[i].t,
    macd: m,
    signal: signal[i],
    hist: m - signal[i],
  }));

  // One example position overlay scaffold
  const entryIdx = 1200;
  const exitIdx = 1700;
  positions.push({
    id: "p1",
    entryT: bars[entryIdx].t,
    entryPrice: bars[entryIdx].c,
    exitT: bars[exitIdx].t,
    exitPrice: bars[exitIdx].c,
    stopSeries: [
      { t: bars[entryIdx].t, y: bars[entryIdx].c - 2.2 },
      { t: bars[entryIdx + 150].t, y: bars[entryIdx + 150].c - 1.6 },
      { t: bars[entryIdx + 300].t, y: bars[entryIdx + 300].c - 1.0 },
    ],
    meta: { note: "mock position" }
  });

  return { bars, volume, macd, markers, events, positions };
}

/**
 * makeMockProvider({ sampleUrl })
 * - Loads ../sampleData.js (relative to src/) by default.
 * - Expects it to export something like:
 *     export const bars = [...]
 *   OR
 *     export default { bars, macd, volume, markers, events, positions }
 */
/**
 * makeMockProvider({ sampleUrl })
 * Resolves sampleUrl relative to THIS module (Providers.js) using import.meta.url.
 *
 * Default "../../sampleData.js" because Providers.js is at /src/data/Providers.js
 * and sampleData.js is at repo root /sampleData.js
 */
/**
 * makeMockProvider({ sampleUrl })
 * - Resolves sampleUrl relative to THIS module using import.meta.url.
 * - Supports modules that export:
 *    (A) loadSample(): Promise<{bars, macd, volume?, markers?, events?, positions?}>
 *    (B) default export { bars, macd, ... }
 *    (C) named exports { bars, macd, ... }
 */
/**
 * makeMockProvider({ sampleUrl })
 * Supports sample modules that export:
 *  - loadSample(): Promise<{ bars, macd, volume?, markers?, events?, positions? }>
 *  - default export { bars, ... }
 *  - named exports { bars, ... }
 *
 * NOTE: Providers.js is /src/data/Providers.js; repo root is two levels up.
 */
export function makeMockProvider({ sampleUrl = "../../sampleData.js" } = {}) {
  return async function provider() {
    const url = new URL(sampleUrl, import.meta.url).href;
    const mod = await import(url);

    if (typeof mod.loadSample === "function") {
      const d = await mod.loadSample();
      return {
        bars: d.bars ?? [],
        macd: d.macd ?? [],
        volume: d.volume ?? [],
        markers: d.markers ?? [],
        events: d.events ?? [],
        positions: d.positions ?? [],
      };
    }

    const d = mod.default ?? mod;

    const bars = d.bars ?? d.candles ?? d.ohlcv ?? mod.bars ?? [];
    const macd = d.macd ?? mod.macd ?? [];
    const volume = d.volume ?? mod.volume ?? [];
    const markers = d.markers ?? mod.markers ?? [];
    const events = d.events ?? mod.events ?? [];
    const positions = d.positions ?? mod.positions ?? [];

    return { bars, macd, volume, markers, events, positions };
  };
}



