export class SpreadLayer {
  draw(ctx, scene) {
    const s = scene._priceScale;
    if (!s) return;
    const pane = scene.panes.price;
    const b = scene.cursorBar;
    if (!b) return;

    const spreadBps = scene.state.settings.spreadBps ?? 0;
    if (spreadBps <= 0) return;

    const mid = b.c;
    const spreadFrac = spreadBps / 10000;
    const half = mid * spreadFrac * 0.5;

    const bid = mid - half;
    const ask = mid + half;

    const yBid = s.yToPix(bid);
    const yAsk = s.yToPix(ask);

    ctx.fillStyle = "rgba(96,165,250,.10)";
    ctx.fillRect(pane.x, Math.min(yBid, yAsk), pane.w, Math.max(1, Math.abs(yAsk - yBid)));

    // thin lines
    ctx.strokeStyle = "rgba(96,165,250,.35)";
    ctx.beginPath();
    ctx.moveTo(pane.x, yBid); ctx.lineTo(pane.x + pane.w, yBid);
    ctx.moveTo(pane.x, yAsk); ctx.lineTo(pane.x + pane.w, yAsk);
    ctx.stroke();
  }
}
