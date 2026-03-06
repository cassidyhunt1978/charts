export class GridLayer {
  draw(ctx, scene) {
    const drawPane = (p) => {
      ctx.strokeStyle = "#1b2230";
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x, p.y, p.w, p.h);

      ctx.strokeStyle = "#141a24";
      const rows = 4;
      for (let i = 1; i < rows; i++) {
        const y = p.y + (p.h * i) / rows;
        ctx.beginPath();
        ctx.moveTo(p.x, y);
        ctx.lineTo(p.x + p.w, y);
        ctx.stroke();
      }
    };

    drawPane(scene.panes.lane);
    drawPane(scene.panes.price);
    drawPane(scene.panes.macd);
  }
}
