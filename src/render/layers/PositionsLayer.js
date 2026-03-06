export class PositionsLayer {
  draw(ctx, scene) {
    const s = scene._priceScale;
    if (!s) return;

    const pane = scene.panes.price;
    const [t0,t1] = scene.xDomain;

    for (const p of scene.positions) {
      const selected = scene.state.selectedPositionId === p.id;

      // Entry line
      if (p.entryT >= t0 && p.entryT <= t1) {
        const x = s.tToX(p.entryT);
        ctx.strokeStyle = "rgba(96,165,250,.75)";
        ctx.beginPath(); ctx.moveTo(x, pane.y); ctx.lineTo(x, pane.y+pane.h); ctx.stroke();
      }

      // Exit line
      if (p.exitT != null && p.exitT >= t0 && p.exitT <= t1) {
        const x = s.tToX(p.exitT);
        ctx.strokeStyle = "rgba(239,68,68,.75)";
        ctx.beginPath(); ctx.moveTo(x, pane.y); ctx.lineTo(x, pane.y+pane.h); ctx.stroke();
      }

      // Stop / TP horizontal lines across pane (pro baseline)
      const drawH = (yValue, color, tag, handleKey) => {
        const y = s.yToPix(yValue);
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2.5 : 2;
        ctx.beginPath(); ctx.moveTo(pane.x, y); ctx.lineTo(pane.x+pane.w, y); ctx.stroke();
        ctx.lineWidth = 1;

        // handle on right
        const hx = pane.x + pane.w - 10;
        const hy = y;
        p._handles ||= {};
        p._handles[handleKey] = { x:hx, y:hy, r:8 };

        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI*2); ctx.fill();

        ctx.fillStyle = "rgba(0,0,0,.55)";
        ctx.fillRect(hx-54, hy-10, 44, 18);
        ctx.fillStyle = "#e5e7eb";
        ctx.font = "12px system-ui";
        ctx.fillText(tag, hx-50, hy+4);
      };

      if (p.stop != null) drawH(p.stop, "rgba(234,179,8,.9)", "STOP", "stop");
      if (p.tp != null)   drawH(p.tp,   "rgba(34,197,94,.9)", "TP",   "tp");

      // If stopSeries exists, keep it (trail)
      if (Array.isArray(p.stopSeries)) {
        ctx.strokeStyle = "rgba(234,179,8,.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started=false;
        for (const pt of p.stopSeries) {
          if (pt.t < t0 || pt.t > t1) continue;
          const x = s.tToX(pt.t);
          const y = s.yToPix(pt.y);
          if (!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
        }
        if (started) ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }
}
