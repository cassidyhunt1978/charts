/**
 * AxisLayer
 * Draws:
 *  - Right-side price axis with tick labels & grid lines
 *  - EMA 9 / EMA 21 overlay on price pane
 *  - Bottom time axis with smart tick spacing
 */

function niceStep(range, targetTicks) {
  const rawStep = range / Math.max(1, targetTicks);
  const mag  = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

function niceTimeStep(spanMs, widthPx) {
  const target = Math.max(3, Math.floor(widthPx / 90));
  const msPerGap = spanMs / target;
  const steps = [
    60_000, 5*60_000, 10*60_000, 15*60_000, 30*60_000,
    60*60_000, 2*60*60_000, 4*60*60_000, 6*60*60_000, 12*60*60_000,
    24*60*60_000, 3*24*60*60_000, 7*24*60*60_000,
  ];
  for (const s of steps) if (s >= msPerGap) return s;
  return 30 * 24 * 60*60_000;
}

function fmtTime(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs < 2 * 60*60_000)
    return d.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });
  if (spanMs < 4 * 24*60*60_000)
    return d.toLocaleString(undefined,  { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
}

export class AxisLayer {
  draw(ctx, scene) {
    this._drawPriceAxis(ctx, scene);
    this._drawEmas(ctx, scene);
    this._drawTimeAxis(ctx, scene);
  }

  _drawPriceAxis(ctx, scene) {
    const ps   = scene._priceScale;
    const pane = scene.panes.price;
    if (!ps || !pane) return;

    const axX = pane.x + pane.w;   // left edge of right-axis strip
    const axW = scene.rightAxisW ?? 62;

    // Strip background
    ctx.fillStyle = "#181c27";
    ctx.fillRect(axX, 0, axW, scene.H);

    // Compute nice tick step
    const range  = ps.yMax - ps.yMin;
    const ticks  = Math.max(3, Math.floor(pane.h / 55));
    const step   = niceStep(range, ticks);
    const first  = Math.ceil(ps.yMin / step) * step;

    ctx.font         = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign    = "left";

    for (let p = first; p <= ps.yMax + 1e-9; p += step) {
      const y = ps.yToPix(p);
      if (y < pane.y || y > pane.y + pane.h) continue;

      // Faint grid line across price pane
      ctx.strokeStyle = "rgba(255,255,255,.05)";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();

      // Tick mark on axis border
      ctx.strokeStyle = "rgba(255,255,255,.18)";
      ctx.beginPath();
      ctx.moveTo(axX, y);
      ctx.lineTo(axX + 5, y);
      ctx.stroke();

      // Label
      ctx.fillStyle = "rgba(200,210,230,.55)";
      ctx.fillText(p.toFixed(2), axX + 8, y);
    }

    // Axis border line
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(axX, pane.y);
    ctx.lineTo(axX, pane.y + pane.h);
    ctx.stroke();
  }

  _drawEmas(ctx, scene) {
    const ps   = scene._priceScale;
    const pane = scene.panes.price;
    if (!ps || !pane) return;

    const ema9  = scene.state.ema9;
    const ema21 = scene.state.ema21;
    const bars  = scene.state.bars;
    if (!ema9?.length || !ema21?.length) return;

    const [t0, t1] = scene.xDomain;

    // Clip EMA lines strictly to the price pane so they never escape
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    ctx.globalAlpha = 0.70;

    const drawLine = (arr, col) => {
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started  = false;
      let prevX    = null;
      let prevV    = null;

      for (let i = 0; i < bars.length; i++) {
        const v = arr[i];
        if (v == null) { started = false; prevX = null; prevV = null; continue; }
        const b = bars[i];
        if (b.t < t0 || b.t > t1) {
          // Track the last out-of-range point so we can interpolate the
          // entry edge when the line re-enters the visible range.
          if (b.t < t0) { prevX = ps.tToX(b.t); prevV = v; }
          started = false;
          continue;
        }
        const x = ps.tToX(b.t);
        const y = ps.yToPix(v);
        if (!started) {
          // Interpolate starting point at the left pane edge if we have a
          // preceding out-of-range point, so the line starts at x=pane.x
          // instead of jumping in from nothing.
          if (prevX !== null && prevX < pane.x) {
            const t  = (pane.x - prevX) / (x - prevX);
            const iy = ps.yToPix(prevV + (v - prevV) * t);
            ctx.moveTo(pane.x, iy);
          } else {
            ctx.moveTo(x, y);
          }
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        prevX = x; prevV = v;
      }
      ctx.stroke();
    };

    drawLine(ema9,  "#f59e0b");   // amber
    drawLine(ema21, "#818cf8");   // indigo

    ctx.restore();
  }

  _drawTimeAxis(ctx, scene) {
    const pane  = scene.panes.macd;
    const price = scene.panes.price;
    if (!pane) return;

    const [t0, t1] = scene.xDomain;
    const spanMs   = t1 - t0;
    const step     = niceTimeStep(spanMs, pane.w);
    const first    = Math.ceil(t0 / step) * step;

    const axisY = pane.y + pane.h - 1;   // very bottom

    ctx.fillStyle = "#181c27";
    ctx.fillRect(pane.x, axisY - 16, pane.w, 16);

    ctx.font         = "10px system-ui";
    ctx.textBaseline = "bottom";
    ctx.textAlign    = "center";
    ctx.strokeStyle  = "rgba(255,255,255,.12)";
    ctx.lineWidth    = 1;

    for (let t = first; t <= t1; t += step) {
      const x = pane.x + ((t - t0) / spanMs) * pane.w;
      if (x < pane.x + 10 || x > pane.x + pane.w - 10) continue;

      // Vertical tick line through all panes
      ctx.strokeStyle = "rgba(255,255,255,.06)";
      ctx.beginPath();
      ctx.moveTo(x, (price ?? pane).y);
      ctx.lineTo(x, axisY - 16);
      ctx.stroke();

      // Short tick mark at bottom
      ctx.strokeStyle = "rgba(255,255,255,.22)";
      ctx.beginPath();
      ctx.moveTo(x, axisY - 16);
      ctx.lineTo(x, axisY - 11);
      ctx.stroke();

      ctx.fillStyle = "rgba(200,210,230,.48)";
      ctx.fillText(fmtTime(t, spanMs), x, axisY);
    }
  }
}
