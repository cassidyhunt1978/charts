import { computeYDomain } from "../../util/scale.js";

export class MACDLayer {
  draw(ctx, scene) {
    const pane = scene.panes.macd;
    const pts = scene.macd;
    if (!pts.length) return;

    const values = [];
    for (const p of pts) values.push(p.hist, p.macd ?? 0, p.signal ?? 0);
    const { yMin, yMax } = computeYDomain(values, 0.20);

    const [t0, t1] = scene.xDomain;
    const tToX = (t) => pane.x + ((t - t0) * pane.w) / (t1 - t0);
    const yToPix = (y) => pane.y + ((yMax - y) * pane.h) / (yMax - yMin);

    const yZero = yToPix(0);

    // hist bars
    const approx = Math.max(20, Math.min(2000, pts.length));
    const w = Math.max(2, Math.floor(pane.w / approx));
    const half = Math.floor(w / 2);

    for (const p of pts) {
      const x = Math.floor(tToX(p.t));
      const yh = yToPix(p.hist);
      ctx.fillStyle = p.hist >= 0 ? "#22c55e" : "#ef4444";
      ctx.fillRect(x - half, Math.min(yZero, yh), w, Math.max(1, Math.abs(yZero - yh)));
    }

    // macd line + signal line (optional)
    const drawLine = (getY, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const x = tToX(p.t);
        const y = yToPix(getY(p));
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (pts[0].macd != null) drawLine(p => p.macd, "#60a5fa");
    if (pts[0].signal != null) drawLine(p => p.signal, "#eab308");
  }
}
