export class CrosshairLayer {
  draw(ctx, scene) {
    if (scene.state.cursorT == null) return;

    const panePrice = scene.panes.price;
    const [t0, t1]  = scene.xDomain;

    const x = panePrice.x + ((scene.state.cursorT - t0) * panePrice.w) / (t1 - t0);
    scene.state.cursorX = x;

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth   = 1;
    ctx.strokeStyle = "rgba(255,255,255,.24)";

    // Vertical line — full canvas height
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, scene.H);
    ctx.stroke();

    // Horizontal line + price bubble — price pane only
    const y = scene.state.cursorY;
    if (y != null && y >= panePrice.y && y <= panePrice.y + panePrice.h) {
      ctx.beginPath();
      ctx.moveTo(panePrice.x, y);
      ctx.lineTo(panePrice.x + panePrice.w, y);
      ctx.stroke();

      // Price label bubble on the right edge of the price pane
      const ps = scene._priceScale;
      if (ps && typeof ps.pixToY === "function") {
        const price  = ps.pixToY(y);
        const label  = price.toFixed(2);
        const bw = 58, bh = 18;
        const bx = panePrice.x + panePrice.w - bw;
        const by = y - bh / 2;

        ctx.setLineDash([]);   // solid for the bubble
        ctx.fillStyle   = "rgba(41,98,255,.90)";
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 3);
        ctx.fill();

        ctx.fillStyle    = "#ffffff";
        ctx.font         = "bold 11px monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign    = "center";
        ctx.fillText(label, bx + bw / 2, y);
      }
    }

    ctx.restore();
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";
  }
}
