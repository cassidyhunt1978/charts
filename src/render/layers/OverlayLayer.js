/**
 * OverlayLayer — draws Bollinger Bands and/or VWAP on the price pane.
 * Runs AFTER CandlesLayer (needs scene._priceScale).
 */
export class OverlayLayer {
  draw(ctx, scene) {
    const pane = scene.panes.price;
    const ps   = scene._priceScale;
    if (!pane || !ps) return;

    const { tToX, yToPix } = ps;
    const bars = scene.bars;
    if (!bars.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    // ── Bollinger Bands ───────────────────────────────────────
    if (scene.bb) {
      const { upper, mid, lower } = scene.bb;

      // Fill band
      ctx.fillStyle = "rgba(96,165,250,.06)";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < bars.length; i++) {
        if (upper[i] == null) continue;
        const x = tToX(bars[i].t);
        const y = yToPix(upper[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      for (let i = bars.length - 1; i >= 0; i--) {
        if (lower[i] == null) continue;
        ctx.lineTo(tToX(bars[i].t), yToPix(lower[i]));
      }
      ctx.closePath();
      ctx.fill();

      // Band lines
      const drawLine = (arr, col, dash = []) => {
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let s = false;
        for (let i = 0; i < bars.length; i++) {
          if (arr[i] == null) continue;
          const x = tToX(bars[i].t);
          const y = yToPix(arr[i]);
          if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };

      drawLine(upper, "rgba(96,165,250,.55)");
      drawLine(lower, "rgba(96,165,250,.55)");
      drawLine(mid,   "rgba(96,165,250,.30)", [4, 4]);
    }

    // ── VWAP ─────────────────────────────────────────────────
    if (scene.vwap) {
      const vwap = scene.vwap;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < bars.length; i++) {
        if (vwap[i] == null) continue;
        const x = tToX(bars[i].t);
        const y = yToPix(vwap[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Label
      if (started) {
        ctx.fillStyle = "#f59e0b";
        ctx.font      = "bold 9px system-ui";
        ctx.fillText("VWAP", pane.x + 4, pane.y + pane.h - 6);
      }
    }

    ctx.restore();
  }
}
