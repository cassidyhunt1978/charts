/**
 * SMCLayer — Smart Money Concepts overlay
 *
 * Detects and draws:
 *   • Order Blocks (OB)  — last opposite-colour candle before an impulse
 *   • Fair Value Gaps (FVG) — 3-bar patterns with price imbalance
 *   • Break of Structure (BOS) / Change of Character (CHoCH)
 */
export class SMCLayer {
  draw(ctx, scene) {
    if (!scene.state.indicators?.smc) return;

    const ps   = scene._priceScale;
    const bars = scene.bars;
    const pane = scene.panes.price;
    if (!pane || !ps || bars.length < 6) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    const x1 = (t) => ps.tToX(t);
    const y1 = (p) => ps.yToPix(p);

    // ── Fair Value Gaps ───────────────────────────────────────────────────
    for (let i = 2; i < bars.length; i++) {
      const prev2 = bars[i - 2];
      const curr  = bars[i];

      // Bullish FVG: gap between prev2.high and curr.low
      if (prev2.h < curr.l) {
        const xL = x1(prev2.t);
        const xR = x1(curr.t) + Math.max(2, Math.floor((ps.tToX(bars[Math.min(i + 2, bars.length - 1)].t) - x1(curr.t)) / 2));
        const yT = y1(curr.l);
        const yB = y1(prev2.h);
        ctx.fillStyle = "rgba(34,197,94,0.12)";
        ctx.fillRect(xL, yT, xR - xL, yB - yT);
        ctx.strokeStyle = "rgba(34,197,94,0.45)";
        ctx.lineWidth = 0.7;
        ctx.strokeRect(xL, yT, xR - xL, yB - yT);
        ctx.fillStyle = "rgba(34,197,94,0.8)";
        ctx.font = "8.5px system-ui";
        ctx.fillText("FVG", xL + 2, yT + 9);
      }

      // Bearish FVG: gap between curr.high and prev2.low
      if (curr.h < prev2.l) {
        const xL = x1(prev2.t);
        const xR = x1(curr.t) + Math.max(2, Math.floor((ps.tToX(bars[Math.min(i + 2, bars.length - 1)].t) - x1(curr.t)) / 2));
        const yT = y1(prev2.l);
        const yB = y1(curr.h);
        ctx.fillStyle = "rgba(239,68,68,0.12)";
        ctx.fillRect(xL, yT, xR - xL, yB - yT);
        ctx.strokeStyle = "rgba(239,68,68,0.45)";
        ctx.lineWidth = 0.7;
        ctx.strokeRect(xL, yT, xR - xL, yB - yT);
        ctx.fillStyle = "rgba(239,68,68,0.8)";
        ctx.font = "8.5px system-ui";
        ctx.fillText("FVG", xL + 2, yT + 9);
      }
    }

    // ── Order Blocks ──────────────────────────────────────────────────────
    const LOOKBACK = Math.min(80, bars.length);
    const impulseLen = 3;

    for (let i = bars.length - impulseLen - 1; i >= bars.length - LOOKBACK && i >= 0; i--) {
      // Bullish OB: last bearish candle before impulse up
      const ob = bars[i];
      const isBear = ob.c < ob.o;
      if (!isBear) continue;

      let impulseUp = true;
      for (let j = 1; j <= impulseLen; j++) {
        if (i + j >= bars.length) { impulseUp = false; break; }
        if (bars[i + j].c < bars[i + j].o) { impulseUp = false; break; }
      }
      if (!impulseUp) continue;

      // Check impulse is significant (≥0.5% per candle on average)
      const iBars = bars.slice(i + 1, i + 1 + impulseLen);
      const moveSum = iBars.reduce((s, b) => s + ((b.c - b.o) / b.o), 0);
      if (moveSum < 0.005) continue;

      const xL = x1(ob.t);
      const xR = x1(bars[Math.min(i + impulseLen + 1, bars.length - 1)].t);
      const yT = y1(Math.max(ob.o, ob.c));
      const yB = y1(Math.min(ob.o, ob.c));
      ctx.fillStyle = "rgba(34,197,94,0.14)";
      ctx.fillRect(xL, yT, Math.max(xR - xL, 4), yB - yT);
      ctx.strokeStyle = "rgba(34,197,94,0.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(xL, yT, Math.max(xR - xL, 4), yB - yT);
      ctx.fillStyle = "rgba(34,197,94,0.9)";
      ctx.font = "bold 8.5px system-ui";
      ctx.fillText("OB+", xL + 2, yT + 9);
    }

    for (let i = bars.length - impulseLen - 1; i >= bars.length - LOOKBACK && i >= 0; i--) {
      // Bearish OB: last bullish candle before impulse down
      const ob = bars[i];
      const isBull = ob.c > ob.o;
      if (!isBull) continue;

      let impulseDown = true;
      for (let j = 1; j <= impulseLen; j++) {
        if (i + j >= bars.length) { impulseDown = false; break; }
        if (bars[i + j].c > bars[i + j].o) { impulseDown = false; break; }
      }
      if (!impulseDown) continue;

      const iBars = bars.slice(i + 1, i + 1 + impulseLen);
      const moveSum = iBars.reduce((s, b) => s + ((b.o - b.c) / b.o), 0);
      if (moveSum < 0.005) continue;

      const xL = x1(ob.t);
      const xR = x1(bars[Math.min(i + impulseLen + 1, bars.length - 1)].t);
      const yT = y1(Math.max(ob.o, ob.c));
      const yB = y1(Math.min(ob.o, ob.c));
      ctx.fillStyle = "rgba(239,68,68,0.14)";
      ctx.fillRect(xL, yT, Math.max(xR - xL, 4), yB - yT);
      ctx.strokeStyle = "rgba(239,68,68,0.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(xL, yT, Math.max(xR - xL, 4), yB - yT);
      ctx.fillStyle = "rgba(239,68,68,0.9)";
      ctx.font = "bold 8.5px system-ui";
      ctx.fillText("OB−", xL + 2, yT + 9);
    }

    // ── BOS / CHoCH ───────────────────────────────────────────────────────
    const WIN = 10;
    if (bars.length < WIN * 2 + 2) { ctx.restore(); return; }

    // Collect swing highs and lows
    const swingHighs = [];
    const swingLows  = [];

    for (let i = WIN; i < bars.length - WIN; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - WIN; j <= i + WIN; j++) {
        if (j === i) continue;
        if (bars[j].h >= bars[i].h) isHigh = false;
        if (bars[j].l <= bars[i].l) isLow  = false;
      }
      if (isHigh) swingHighs.push(i);
      if (isLow)  swingLows.push(i);
    }

    // BOS: price closes above last swing high
    for (let k = swingHighs.length - 1; k >= Math.max(0, swingHighs.length - 4); k--) {
      const shIdx = swingHighs[k];
      const shPrice = bars[shIdx].h;
      // Find first bar after shIdx that closes above
      for (let i = shIdx + 1; i < bars.length; i++) {
        if (bars[i].c > shPrice) {
          const bx = x1(bars[i].t);
          const by = y1(shPrice);
          ctx.strokeStyle = "rgba(250,204,21,0.8)";
          ctx.lineWidth   = 1;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(x1(bars[shIdx].t), by);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle  = "rgba(250,204,21,0.95)";
          ctx.font       = "bold 9px system-ui";
          ctx.fillText("BOS", bx + 2, by - 3);
          break;
        }
      }
    }

    // CHoCH: price closes below last swing low
    for (let k = swingLows.length - 1; k >= Math.max(0, swingLows.length - 4); k--) {
      const slIdx = swingLows[k];
      const slPrice = bars[slIdx].l;
      for (let i = slIdx + 1; i < bars.length; i++) {
        if (bars[i].c < slPrice) {
          const bx = x1(bars[i].t);
          const by = y1(slPrice);
          ctx.strokeStyle = "rgba(192,132,252,0.8)";
          ctx.lineWidth   = 1;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(x1(bars[slIdx].t), by);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(192,132,252,0.95)";
          ctx.font      = "bold 9px system-ui";
          ctx.fillText("CHoCH", bx + 2, by + 11);
          break;
        }
      }
    }

    ctx.restore();
  }
}
