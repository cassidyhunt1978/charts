/**
 * DrawingLayer — renders horizontal S/R lines and trendlines on the price pane.
 * Also draws ghost previews while placing drawings.
 */
export class DrawingLayer {
  draw(ctx, scene) {
    const pane = scene.panes.price;
    const ps   = scene._priceScale;
    if (!pane || !ps) return;

    const { tToX, yToPix } = ps;

    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    // ── Ghost preview for in-progress drawings ──────────────────────────────
    const wip  = scene.state._drawingInProgress;
    const mode = scene.state.drawingMode;

    if (mode === "hline" && scene.state.cursorY != null) {
      // Horizontal ghost at cursor Y
      const y = scene.state.cursorY;
      if (y >= pane.y && y <= pane.y + pane.h) {
        ctx.strokeStyle = "rgba(245,158,11,0.6)";
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pane.x, y);
        ctx.lineTo(pane.x + pane.w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        // Price label ghost
        const price = ps.pixToY ? ps.pixToY(y) : null;
        if (price != null) {
          ctx.restore();
          ctx.fillStyle = "rgba(245,158,11,0.75)";
          ctx.font = "bold 10.5px system-ui";
          ctx.fillText(price.toFixed(2), pane.x + pane.w + 4, y + 4);
          ctx.save();
          ctx.beginPath();
          ctx.rect(pane.x, pane.y, pane.w, pane.h);
          ctx.clip();
        }
      }
    }

    if (mode === "trendline" && wip?.t1 != null && wip._previewT != null) {
      // In-progress trendline ghost from anchor to cursor
      const x1 = tToX(wip.t1),         y1 = yToPix(wip.p1);
      const x2 = tToX(wip._previewT),  y2 = yToPix(wip._previewP ?? wip.p1);

      // Anchor dot
      ctx.fillStyle = "rgba(96,165,250,0.9)";
      ctx.beginPath();
      ctx.arc(x1, y1, 5, 0, Math.PI * 2);
      ctx.fill();

      // Dashed ghost line to cursor
      ctx.strokeStyle = "rgba(96,165,250,0.55)";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Cursor dot
      ctx.fillStyle = "rgba(96,165,250,0.7)";
      ctx.beginPath();
      ctx.arc(x2, y2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Finalised drawings ───────────────────────────────────────────────────
    const drawings = scene.drawings;
    if (drawings && drawings.length) {
      for (const d of drawings) {
        const selected = scene.state.selectedDrawingId === d.id;
        const col = d.color ?? (d.type === "hline" ? "#f59e0b" : "#60a5fa");

        if (d.type === "hline") {
          const y = yToPix(d.price);
          if (y < pane.y || y > pane.y + pane.h) continue;

          ctx.strokeStyle = selected ? "#fff" : col;
          ctx.lineWidth   = selected ? 2 : 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(pane.x, y);
          ctx.lineTo(pane.x + pane.w, y);
          ctx.stroke();
          ctx.setLineDash([]);

          // Price label outside clip
          ctx.restore();
          ctx.fillStyle = col;
          ctx.font = "bold 10.5px system-ui";
          ctx.fillText(d.price.toFixed(2), pane.x + pane.w + 4, y + 4);
          if (d.label) {
            ctx.fillStyle = "rgba(255,255,255,.6)";
            ctx.font = "10px system-ui";
            ctx.fillText(d.label, pane.x + pane.w + 4, y - 5);
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(pane.x, pane.y, pane.w, pane.h);
          ctx.clip();

          d._screenY = y;
          d._screenX = pane.x + 12;

        } else if (d.type === "trendline") {
          if (!d.t1 || !d.t2) continue;
          const x1 = tToX(d.t1), y1 = yToPix(d.p1);
          const x2 = tToX(d.t2), y2 = yToPix(d.p2);

          const dx    = x2 - x1;
          const dy    = y2 - y1;
          const slope = dx !== 0 ? dy / dx : 0;
          const yLeft  = y1 + slope * (pane.x - x1);
          const yRight = y1 + slope * (pane.x + pane.w - x1);

          ctx.strokeStyle = selected ? "#fff" : col;
          ctx.lineWidth   = selected ? 2 : 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(pane.x, yLeft);
          ctx.lineTo(pane.x + pane.w, yRight);
          ctx.stroke();

          for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
            ctx.fillStyle = selected ? "#fff" : col;
            ctx.beginPath();
            ctx.arc(ex, ey, 4, 0, Math.PI * 2);
            ctx.fill();
          }

          d._screenX  = x1;
          d._screenY  = y1;
          d._screenX2 = x2;
          d._screenY2 = y2;
        }
      }
    }

    ctx.restore();
  }
}
