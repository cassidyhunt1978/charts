/**
 * SignalsLayer.js — renders computed signal arrows + stop/target lines on chart
 * + a signal summary strip pinned to the top of the price pane
 * + background strategy overlay signals from StrategyOverlay
 */
export class SignalsLayer {
  draw(ctx, scene) {
    const signals    = scene.state?.computedSignals;
    const trades     = scene.state?.computedTrades;
    const bgSignals  = scene.state?.bgStrategySignals;
    const hasBg      = bgSignals?.length > 0;
    if (!signals?.length && !trades?.length && !hasBg) return;

    const ps   = scene._priceScale;
    const pane = scene.panes?.price;
    if (!ps || !pane) return;

    const [t0, t1] = scene.xDomain;
    const dpr = window.devicePixelRatio || 1;

    // Build a quick lookup: signalId → its resolved trade
    const tradeByEntryT = new Map();
    if (trades) {
      for (const tr of trades) tradeByEntryT.set(tr.entryT, tr);
    }

    ctx.save();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    // ── Background strategy overlay (from trading DB) ─────────────────────
    if (hasBg) {
      ctx.save();
      for (const sig of bgSignals) {
        if (sig.t < t0 || sig.t > t1) continue;
        const x = ps.tToX(sig.t);
        if (x < pane.x || x > pane.x + pane.w) continue;
        const price  = sig.price;
        if (price == null) continue;
        const y      = ps.yToPix(price);
        const isLong = sig.direction === "long";
        const clr    = sig._colour ?? '#f59e0b';
        const sz = 6, tip = 8, offset = 10;

        ctx.globalAlpha = 0.55;
        ctx.fillStyle   = clr;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        if (isLong) {
          const base = y + offset;
          ctx.moveTo(x,      base);
          ctx.lineTo(x - sz, base + tip);
          ctx.lineTo(x + sz, base + tip);
        } else {
          const base = y - offset;
          ctx.moveTo(x,      base);
          ctx.lineTo(x - sz, base - tip);
          ctx.lineTo(x + sz, base - tip);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ── Draw stop/target zones for visible trades ─────────────────────────
    if (trades) {
      for (const tr of trades) {
        if (tr.entryT > t1 || tr.exitT < t0) continue;
        const x0 = Math.max(pane.x, ps.tToX(tr.entryT));
        const x1 = Math.min(pane.x + pane.w, ps.tToX(tr.exitT));
        if (x1 < x0) continue;

        const yStop   = ps.yToPix(tr.stop);
        const yTarget = ps.yToPix(tr.target);
        const yEntry  = ps.yToPix(tr.entryPrice);
        const isLong  = tr.direction === "long";
        const won     = tr.pnlUSD > 0;
        const tradeClr = won ? "#22c55e" : "#ef4444";

        // Risk band fill
        const yTop = Math.min(yStop, yTarget);
        const yBot = Math.max(yStop, yTarget);
        ctx.setLineDash([]);
        ctx.fillStyle = isLong ? "rgba(34,197,94,0.07)" : "rgba(239,68,68,0.07)";
        ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);

        // Entry line
        ctx.strokeStyle = "rgba(148,163,184,0.5)";
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x0, yEntry); ctx.lineTo(x1, yEntry); ctx.stroke();

        // Stop line (red)
        ctx.strokeStyle = "rgba(239,68,68,0.75)";
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(x0, yStop); ctx.lineTo(x1, yStop); ctx.stroke();

        // Target line (green)
        ctx.strokeStyle = "rgba(34,197,94,0.75)";
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(x0, yTarget); ctx.lineTo(x1, yTarget); ctx.stroke();

        ctx.setLineDash([]);

        // Exit dot — larger and outlined
        const xExit = ps.tToX(tr.exitT);
        const yExit = ps.yToPix(tr.exitPrice);
        ctx.shadowColor = tradeClr;
        ctx.shadowBlur  = 10;
        ctx.fillStyle   = tradeClr;
        ctx.strokeStyle = "#0d1829";
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.arc(xExit, yExit, 6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;

        // PnL label at exit
        const pnlTxt = (tr.pnlUSD >= 0 ? "+" : "") + "$" + tr.pnlUSD.toFixed(0);
        ctx.font      = `bold ${11}px monospace`;
        ctx.fillStyle = tradeClr;
        ctx.textAlign = "left";
        ctx.fillText(pnlTxt, xExit + 8, yExit + 4);
      }
    }

    ctx.setLineDash([]);

    // ── Draw entry signal arrows ──────────────────────────────────────────
    const visibleSigs = [];

    for (const sig of signals) {
      if (sig.t < t0 || sig.t > t1) continue;
      const x = ps.tToX(sig.t);
      if (x < pane.x || x > pane.x + pane.w) continue;
      visibleSigs.push({ sig, x });

      const y      = ps.yToPix(sig.price);
      const isLong = sig.direction === "long";
      const trade  = tradeByEntryT.get(sig.t);
      const won    = trade ? trade.pnlUSD > 0 : null;

      // Color: green for long, red for short; dim if trade resolved as loss
      const arrowClr  = isLong ? "#00ff88" : "#ff4466";
      const glowClr   = isLong ? "#00ff88" : "#ff4466";
      const stemClr   = isLong ? "rgba(0,255,136,0.5)" : "rgba(255,68,102,0.5)";

      const sz     = 13;    // triangle half-width in px (CSS px, not DPR)
      const tip    = 16;    // triangle height in px
      const offset = 18;    // gap between candle close and arrow base

      // Vertical stem from price to arrow
      ctx.strokeStyle = stemClr;
      ctx.lineWidth   = 2;
      ctx.setLineDash([3, 3]);
      if (isLong) {
        ctx.beginPath();
        ctx.moveTo(x, y + 2);
        ctx.lineTo(x, y + offset + tip + 4);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(x, y - 2);
        ctx.lineTo(x, y - offset - tip - 4);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Glow pass (draw twice — once blurred, once sharp)
      for (let pass = 0; pass < 2; pass++) {
        ctx.shadowColor = glowClr;
        ctx.shadowBlur  = pass === 0 ? 18 : 0;
        ctx.fillStyle   = arrowClr;
        ctx.strokeStyle = "#0d1829";
        ctx.lineWidth   = 2;

        ctx.beginPath();
        if (isLong) {
          const base = y + offset;      // tip of arrow (pointing up)
          ctx.moveTo(x,        base);
          ctx.lineTo(x - sz,   base + tip);
          ctx.lineTo(x + sz,   base + tip);
        } else {
          const base = y - offset;      // tip of arrow (pointing down)
          ctx.moveTo(x,        base);
          ctx.lineTo(x - sz,   base - tip);
          ctx.lineTo(x + sz,   base - tip);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Label bubble: price + R:R + win/loss badge
      const labelParts = [];
      labelParts.push(sig.price.toFixed(sig.price > 100 ? 2 : 4));
      if (sig.rr != null) labelParts.push(`${sig.rr.toFixed(1)}R`);
      if (won !== null)   labelParts.push(won ? "✓" : "✗");
      const labelTxt = labelParts.join("  ");

      ctx.font = `bold 11px monospace`;
      const tw = ctx.measureText(labelTxt).width;
      const bw = tw + 12;
      const bh = 15;
      const bx = x - bw / 2;
      const by = isLong
        ? y + offset + tip + 8
        : y - offset - tip - 8 - bh;

      // Bubble background
      ctx.fillStyle = isLong ? "rgba(0,30,15,0.88)" : "rgba(30,0,10,0.88)";
      ctx.strokeStyle = arrowClr;
      ctx.lineWidth = 1;
      _roundRect(ctx, bx, by, bw, bh, 4);
      ctx.fill(); ctx.stroke();

      // Bubble text
      ctx.fillStyle = won === false ? "#fca5a5" : won === true ? "#86efac" : arrowClr;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labelTxt, x, by + bh / 2);
    }

    ctx.restore();

    // ── Signal summary strip — pinned to top of price pane ────────────────
    if (visibleSigs.length === 0) return;

    ctx.save();
    const stripH = 20;
    const stripY = pane.y + 4;

    // Background pill
    ctx.fillStyle = "rgba(13,24,41,0.82)";
    ctx.strokeStyle = "rgba(99,102,241,0.4)";
    ctx.lineWidth = 1;
    _roundRect(ctx, pane.x + 6, stripY, pane.w - 12, stripH, 6);
    ctx.fill(); ctx.stroke();

    // Title
    ctx.font      = "bold 10px monospace";
    ctx.fillStyle = "#6366f1";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const titleTxt = `⚡ ${visibleSigs.length} signal${visibleSigs.length !== 1 ? "s" : ""}`;
    ctx.fillText(titleTxt, pane.x + 14, stripY + stripH / 2);
    let cursor = pane.x + 14 + ctx.measureText(titleTxt).width + 10;

    ctx.font = "10px monospace";

    for (const { sig, x } of visibleSigs) {
      const trade   = tradeByEntryT.get(sig.t);
      const isLong  = sig.direction === "long";
      const won     = trade ? trade.pnlUSD > 0 : null;
      const arrow   = isLong ? "▲" : "▼";
      const clr     = isLong ? "#00ff88" : "#ff4466";
      const badge   = won === true ? " ✓" : won === false ? " ✗" : "";
      const time    = _fmtTime(sig.t);
      const chip    = `${arrow}${time}${badge}`;

      const chipW = ctx.measureText(chip).width + 10;
      if (cursor + chipW > pane.x + pane.w - 10) break;  // don't overflow

      // Chip background
      ctx.fillStyle = isLong ? "rgba(0,255,136,0.1)" : "rgba(255,68,102,0.1)";
      ctx.strokeStyle = clr + "66";
      ctx.lineWidth = 1;
      _roundRect(ctx, cursor, stripY + 3, chipW, stripH - 6, 3);
      ctx.fill(); ctx.stroke();

      // Chip text + dot marker
      ctx.fillStyle   = clr;
      ctx.textAlign   = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(chip, cursor + chipW / 2, stripY + stripH / 2);

      // Tick mark pointing down to the signal's x position on chart
      ctx.strokeStyle = clr + "55";
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, stripY + stripH);
      ctx.lineTo(x, stripY + stripH + 8);
      ctx.stroke();
      ctx.setLineDash([]);

      cursor += chipW + 4;
    }

    ctx.restore();

    // ── Background strategy legend — only when bg signals present ─────────
    if (hasBg) {
      const seen = new Map();  // stratName → colour
      for (const sig of bgSignals) {
        if (sig.t >= t0 && sig.t <= t1 && sig._bgStrategy) {
          seen.set(sig._bgStrategy, sig._colour ?? '#f59e0b');
        }
      }
      if (seen.size) {
        ctx.save();
        ctx.font = '9px monospace';
        ctx.textBaseline = 'middle';
        const bgStripH = 16;
        const bgStripY = pane.y + (visibleSigs.length ? 28 : 4);
        let bx = pane.x + 6;
        for (const [name, colour] of seen) {
          const label = `◆ ${name.slice(0, 20)}`;
          const lw    = ctx.measureText(label).width + 10;
          if (bx + lw > pane.x + pane.w - 6) break;
          ctx.globalAlpha   = 0.75;
          ctx.fillStyle     = 'rgba(13,24,41,0.75)';
          ctx.strokeStyle   = colour + '88';
          ctx.lineWidth     = 1;
          _roundRect(ctx, bx, bgStripY, lw, bgStripH, 4);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle   = colour;
          ctx.textAlign   = 'left';
          ctx.fillText(label, bx + 5, bgStripY + bgStripH / 2);
          ctx.globalAlpha = 1;
          bx += lw + 4;
        }
        ctx.restore();
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const mo = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return `${mo}/${dd} ${hh}:${mm}`;
}
