export class MarkersLayer {
  draw(ctx, scene) {
    const pane = scene.panes.price;
    const s = scene._priceScale;
    if (!s) return;

    for (const m of scene.markers) {
      // Only draw price-pane markers if they have price or are set to price pane
      if (m.pane !== "price") continue;
      if (m.t < scene.xDomain[0] || m.t > scene.xDomain[1]) continue;

      const x = s.tToX(m.t);
      const price = (m.price != null) ? m.price : null;
      if (price == null) continue;
      const y = s.yToPix(price);

      m._screenX = x;
      m._screenY = y;
      m._screenPane = "price";

      ctx.fillStyle = m.kind === "buy" ? "#22c55e" : "#ef4444";
      ctx.beginPath();
      if (m.kind === "buy") {
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x - 8, y + 7);
        ctx.lineTo(x + 8, y + 7);
      } else {
        ctx.moveTo(x, y + 9);
        ctx.lineTo(x - 8, y - 7);
        ctx.lineTo(x + 8, y - 7);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
}
