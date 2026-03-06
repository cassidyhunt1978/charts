import { computeYDomain } from "../../util/scale.js";

export class CandlesLayer {
  draw(ctx, scene) {
    const pane = scene.panes.price;
    const bars = scene.bars;
    if (!bars.length) return;

    const { yMin, yMax } = computeYDomain(bars.map(b => [b.l, b.h]).flat(), 0.08);
    const [t0, t1] = scene.xDomain;

    const tToX = (t) => pane.x + ((t - t0) * pane.w) / (t1 - t0);
    const xToT = (x) => t0 + ((x - pane.x) * (t1 - t0)) / pane.w;

    const yToPix = (y) => pane.y + ((yMax - y) * pane.h) / (yMax - yMin);
    const pixToY = (py) => yMax - ((py - pane.y) * (yMax - yMin)) / pane.h;

    const approx = Math.max(20, Math.min(2000, bars.length));
    const w = Math.max(2, Math.floor(pane.w / approx));
    const half = Math.floor(w / 2);

    for (const b of bars) {
      const x = Math.floor(tToX(b.t));
      if (x < pane.x - 50 || x > pane.x + pane.w + 50) continue;

      const yo = yToPix(b.o);
      const yc = yToPix(b.c);
      const yh = yToPix(b.h);
      const yl = yToPix(b.l);

      ctx.strokeStyle = "#94a3b8";
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x, yl);
      ctx.stroke();

      const up = b.c >= b.o;
      ctx.fillStyle = up ? "#22c55e" : "#ef4444";
      const top = Math.min(yo, yc);
      const bot = Math.max(yo, yc);
      ctx.fillRect(x - half, top, w, Math.max(1, bot - top));
    }

    scene._priceScale = { yMin, yMax, tToX, xToT, yToPix, pixToY };
  }
}
