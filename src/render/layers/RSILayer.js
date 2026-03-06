/**
 * RSILayer — draws RSI(14) in the rsi pane.
 */
export class RSILayer {
  draw(ctx, scene) {
    if (!scene.rsi || !scene.panes.rsi) return;
    const pane = scene.panes.rsi;
    const rsi  = scene.rsi;
    const bars = scene.bars;
    if (!bars.length) return;

    const [t0, t1] = scene.xDomain;
    const span     = t1 - t0;
    if (!(span > 0)) return;

    const tToX   = t => pane.x + ((t - t0) / span) * pane.w;
    const yToPix = v => pane.y + ((100 - v) / 100) * pane.h;

    // Background
    ctx.fillStyle = "#0d111a";
    ctx.fillRect(pane.x, pane.y, pane.w, pane.h);

    // OB / OS shading
    ctx.fillStyle = "rgba(239,68,68,.07)";
    ctx.fillRect(pane.x, pane.y, pane.w, pane.h * 0.3);         // 70–100
    ctx.fillStyle = "rgba(34,197,94,.07)";
    ctx.fillRect(pane.x, pane.y + pane.h * 0.7, pane.w, pane.h * 0.3); // 0–30

    // Gridlines at 70, 50, 30
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 4]);
    for (const level of [70, 50, 30]) {
      const y = yToPix(level);
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Clip to pane
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    // RSI line
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bars.length; i++) {
      const v = rsi[i];
      if (v == null) continue;
      const x = tToX(bars[i].t);
      const y = yToPix(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // Label
    ctx.fillStyle = "rgba(167,139,250,.9)";
    ctx.font      = "bold 10px system-ui";
    ctx.fillText("RSI 14", pane.x + 4, pane.y + 11);

    // Current value
    const lastRsi = [...rsi].reverse().find(v => v != null);
    if (lastRsi != null) {
      const col = lastRsi > 70 ? "#ef4444" : lastRsi < 30 ? "#22c55e" : "#94a3b8";
      ctx.fillStyle = col;
      ctx.font      = "bold 11px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(lastRsi.toFixed(1), pane.x + pane.w - 2, pane.y + 11);
      ctx.textAlign = "left";
    }
  }
}
