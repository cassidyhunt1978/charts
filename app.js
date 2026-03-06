import { loadSample } from "./sampleData.js";

const canvas = document.getElementById("c");
const legend = document.getElementById("legend");
const ctx = canvas.getContext("2d", { alpha: false });

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => {
  resize();
  render();
});

const state = {
  bars: [],
  macd: [],      // {t, macd, signal, hist}
  markers: [],   // {t, pane, kind, price?}
  xDomain: [0, 0],
  cursorT: null,
  isPanning: false,
  panStartX: 0,
  panStartDomain: null,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function bisectByT(arr, t) {
  // returns nearest index by time
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo >= arr.length) return arr.length - 1;
  const prev = lo - 1;
  return (Math.abs(arr[lo].t - t) < Math.abs(arr[prev].t - t)) ? lo : prev;
}

function sliceVisible(bars, t0, t1) {
  // bars assumed sorted by t
  if (!bars.length) return [];
  // find first index >= t0
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t0) lo = mid + 1; else hi = mid;
  }
  const start = lo;

  // find last index <= t1
  lo = 0; hi = bars.length - 1;
  while (lo < hi) {
    const mid = ((lo + hi + 1) >> 1);
    if (bars[mid].t > t1) hi = mid - 1; else lo = mid;
  }
  const end = lo;

  return bars.slice(start, end + 1);
}

function setData(data) {
  state.bars = data.bars;
  state.macd = data.macd;
  state.markers = data.markers;

  const n = state.bars.length;
  const lookback = Math.min(300, n);
  const t0 = state.bars[n - lookback].t;
  const t1 = state.bars[n - 1].t;
  state.xDomain = [t0, t1];
}

function tToX(t, plot) {
  const [t0, t1] = state.xDomain;
  return plot.x + (t - t0) * (plot.w / (t1 - t0));
}
function xToT(x, plot) {
  const [t0, t1] = state.xDomain;
  const u = (x - plot.x) / plot.w;
  return t0 + u * (t1 - t0);
}

function computeYScale(values, padFrac = 0.08) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * padFrac;
  return { min: min - pad, max: max + pad };
}

function yToPix(y, plot, yMin, yMax) {
  return plot.y + (yMax - y) * (plot.h / (yMax - yMin));
}

function drawText(x, y, s) {
  ctx.fillStyle = "#e6e6e6";
  ctx.font = "12px system-ui";
  ctx.fillText(s, x, y);
}

function drawGrid(plot, rows = 5) {
  ctx.strokeStyle = "#141a24";
  ctx.lineWidth = 1;

  for (let i = 0; i <= rows; i++) {
    const y = plot.y + (plot.h * i) / rows;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#1b2230";
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
}

function drawCandles(plot, bars, yMin, yMax) {
  const w = Math.max(2, Math.floor(plot.w / Math.max(30, bars.length)));
  for (const b of bars) {
    const x = tToX(b.t, plot);
    if (x < plot.x - 50 || x > plot.x + plot.w + 50) continue;

    const yo = yToPix(b.o, plot, yMin, yMax);
    const yc = yToPix(b.c, plot, yMin, yMax);
    const yh = yToPix(b.h, plot, yMin, yMax);
    const yl = yToPix(b.l, plot, yMin, yMax);

    // wick
    ctx.strokeStyle = "#94a3b8";
    ctx.beginPath();
    ctx.moveTo(x, yh);
    ctx.lineTo(x, yl);
    ctx.stroke();

    // body
    const top = Math.min(yo, yc);
    const bot = Math.max(yo, yc);
    const bodyH = Math.max(1, bot - top);

    const up = b.c >= b.o;
    ctx.fillStyle = up ? "#22c55e" : "#ef4444";
    ctx.fillRect(Math.floor(x - w / 2), Math.floor(top), w, Math.floor(bodyH));
  }
}

function drawMACD(plot, points, yMin, yMax) {
  // hist as bars, macd + signal as lines
  const w = Math.max(2, Math.floor(plot.w / Math.max(30, points.length)));

  const y0 = yToPix(0, plot, yMin, yMax);

  // hist
  for (const p of points) {
    const x = tToX(p.t, plot);
    const yh = yToPix(p.hist, plot, yMin, yMax);
    const top = Math.min(y0, yh);
    const h = Math.max(1, Math.abs(yh - y0));
    ctx.fillStyle = p.hist >= 0 ? "#22c55e" : "#ef4444";
    ctx.fillRect(Math.floor(x - w / 2), Math.floor(top), w, Math.floor(h));
  }

  // lines
  function drawLine(getY, stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      const x = tToX(p.t, plot);
      const y = yToPix(getY(p), plot, yMin, yMax);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawLine(p => p.macd, "#60a5fa");
  drawLine(p => p.signal, "#eab308");
}

function drawMarkers(plot, bars, yMin, yMax, markers) {
  for (const m of markers) {
    if (m.pane !== "price") continue;
    const x = tToX(m.t, plot);
    if (x < plot.x || x > plot.x + plot.w) continue;

    // if price not provided, snap to nearest bar close
    let price = m.price;
    if (price == null) {
      const idx = bisectByT(bars, m.t);
      price = bars[idx]?.c ?? 0;
    }
    const y = yToPix(price, plot, yMin, yMax);

    ctx.fillStyle = m.kind === "buy" ? "#22c55e" : "#ef4444";
    ctx.beginPath();
    if (m.kind === "buy") {
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x - 7, y + 6);
      ctx.lineTo(x + 7, y + 6);
    } else {
      ctx.moveTo(x, y + 8);
      ctx.lineTo(x - 7, y - 6);
      ctx.lineTo(x + 7, y - 6);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawCrosshair(plot, t) {
  const x = tToX(t, plot);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, plot.y);
  ctx.lineTo(x, plot.y + plot.h);
  ctx.stroke();
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  const pad = 10;
  const priceH = Math.floor((H - pad * 3) * 0.65);
  const macdH = (H - pad * 3) - priceH;

  const pricePlot = { x: pad, y: pad, w: W - pad * 2, h: priceH };
  const macdPlot  = { x: pad, y: pad * 2 + priceH, w: W - pad * 2, h: macdH };

  // clear
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, W, H);

  const [t0, t1] = state.xDomain;
  const barsV = sliceVisible(state.bars, t0, t1);
  const macdV = sliceVisible(state.macd, t0, t1);

  drawGrid(pricePlot);
  drawGrid(macdPlot);

  // scales
  const priceVals = [];
  for (const b of barsV) { priceVals.push(b.l, b.h); }
  const { min: pMin, max: pMax } = computeYScale(priceVals);

  const macdVals = [];
  for (const p of macdV) { macdVals.push(p.macd, p.signal, p.hist); }
  const { min: mMin, max: mMax } = computeYScale(macdVals, 0.15);

  // series
  drawCandles(pricePlot, barsV, pMin, pMax);
  drawMarkers(pricePlot, state.bars, pMin, pMax, state.markers);
  drawMACD(macdPlot, macdV, mMin, mMax);

  // crosshair + legend
  if (state.cursorT != null) {
    drawCrosshair(pricePlot, state.cursorT);
    drawCrosshair(macdPlot, state.cursorT);

    const idx = barsV.length ? bisectByT(barsV, state.cursorT) : -1;
    const b = idx >= 0 ? barsV[idx] : null;

    if (b) {
      legend.innerHTML =
        `t: ${new Date(b.t).toLocaleString()}<br>` +
        `O:${b.o.toFixed(2)} H:${b.h.toFixed(2)} L:${b.l.toFixed(2)} C:${b.c.toFixed(2)}`;
    } else {
      legend.textContent = `t=${new Date(state.cursorT).toISOString()}`;
    }
  } else {
    legend.textContent = "";
  }

  // labels
  drawText(pricePlot.x + 6, pricePlot.y + 16, "PRICE");
  drawText(macdPlot.x + 6, macdPlot.y + 16, "MACD");
}

// interactions
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;

  // use the price plot area for x mapping
  const pad = 10;
  const plot = { x: pad, y: pad, w: rect.width - pad * 2, h: rect.height - pad * 2 };
  const t = xToT(x, plot);
  state.cursorT = t;

  if (state.isPanning && state.panStartDomain) {
    const dx = x - state.panStartX;
    const [t0, t1] = state.panStartDomain;
    const dt = -(dx / rect.width) * (t1 - t0);
    state.xDomain = [t0 + dt, t1 + dt];
  }

  render();
});

canvas.addEventListener("mouseleave", () => { state.cursorT = null; render(); });

canvas.addEventListener("mousedown", (e) => {
  state.isPanning = true;
  state.panStartX = e.offsetX;
  state.panStartDomain = [...state.xDomain];
});
window.addEventListener("mouseup", () => { state.isPanning = false; state.panStartDomain = null; });

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;

  const [t0, t1] = state.xDomain;
  const anchor = t0 + (x / rect.width) * (t1 - t0);

  const zoom = Math.exp(-e.deltaY * 0.001);
  const span = (t1 - t0) / zoom;

  state.xDomain = [anchor - span * 0.5, anchor + span * 0.5];

  // clamp to data bounds
  const minT = state.bars[0]?.t ?? state.xDomain[0];
  const maxT = state.bars.at(-1)?.t ?? state.xDomain[1];
  const newSpan = state.xDomain[1] - state.xDomain[0];
  state.xDomain[0] = clamp(state.xDomain[0], minT, maxT - newSpan);
  state.xDomain[1] = state.xDomain[0] + newSpan;

  render();
}, { passive: false });

// boot
resize();
setData(await loadSample());
render();