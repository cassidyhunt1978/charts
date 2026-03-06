export async function loadSample() {
  // Generate a tiny synthetic OHLCV + fake MACD + markers
  const bars = [];
  const macd = [];
  const markers = [];

  const start = Date.now() - 1000 * 60 * 400; // ~400 minutes ago
  let price = 100;

  for (let i = 0; i < 400; i++) {
    const t = start + i * 60_000;
    const drift = (Math.sin(i / 35) * 0.2);
    const noise = (Math.random() - 0.5) * 0.6;

    const o = price;
    const c = price + drift + noise;
    const h = Math.max(o, c) + Math.random() * 0.5;
    const l = Math.min(o, c) - Math.random() * 0.5;
    const v = 100 + Math.random() * 50;

    bars.push({ t, o, h, l, c, v });

    // Fake MACD-ish values for now
    const m = Math.sin(i / 18) * 1.2;
    const s = Math.sin(i / 22) * 1.0;
    macd.push({ t, macd: m, signal: s, hist: m - s });

    // Drop a few markers
    if (i === 80 || i === 180 || i === 300) markers.push({ t, pane: "price", kind: "buy", price: l });
    if (i === 120 || i === 240 || i === 360) markers.push({ t, pane: "price", kind: "sell", price: h });

    price = c;
  }

  return { bars, macd, markers };
}