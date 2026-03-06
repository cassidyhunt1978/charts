/**
 * VolumeProfileLayer — Visible Range Volume Profile (VPVR)
 * Draws a horizontal histogram anchored to the right of the price pane.
 * Highlights POC (Point of Control) and Value Area (70% of total volume).
 */
export class VolumeProfileLayer {
  draw(ctx, scene) {
    if (!scene.state.indicators?.vpvr) return;

    const pane   = scene.panes.price;
    const ps     = scene._priceScale;
    const bars   = scene.bars;
    const volume = scene.volume;
    if (!pane || !ps || !bars.length) return;

    const { yMin, yMax } = ps;
    if (yMax <= yMin) return;

    // ── Build price buckets ─────────────────────────────────────────────────
    const ROWS  = scene.state.vpvrRows ?? 120;
    const range = yMax - yMin;
    const step  = range / ROWS;

    const buckets  = new Float64Array(ROWS);       // total volume per row
    const buyVol   = new Float64Array(ROWS);
    const sellVol  = new Float64Array(ROWS);

    // Volume array keyed by time for fast lookup
    const volMap = new Map();
    for (const v of volume) volMap.set(v.t, v.v ?? 0);

    for (const b of bars) {
      const v   = volMap.get(b.t) ?? 0;
      if (!v) continue;
      // Distribute volume proportionally across the bar's range
      const bLo  = b.l, bHi = b.h;
      const barRange = Math.max(bHi - bLo, step * 0.001);
      const iLo  = Math.max(0,       Math.floor((bLo - yMin) / step));
      const iHi  = Math.min(ROWS - 1, Math.floor((bHi - yMin) / step));
      const span = iHi - iLo + 1;
      const vPer = v / span;
      const bull = b.c >= b.o;
      for (let i = iLo; i <= iHi; i++) {
        buckets[i] += vPer;
        if (bull) buyVol[i] += vPer; else sellVol[i] += vPer;
      }
    }

    // ── Find POC & Value Area ───────────────────────────────────────────────
    let maxVol = 0, pocIdx = 0;
    let totalVol = 0;
    for (let i = 0; i < ROWS; i++) {
      totalVol += buckets[i];
      if (buckets[i] > maxVol) { maxVol = buckets[i]; pocIdx = i; }
    }
    const vaTarget = totalVol * 0.70;

    // VA: expand outward from POC until 70% of volume is captured
    let vaLo = pocIdx, vaHi = pocIdx, vaSum = buckets[pocIdx];
    while (vaSum < vaTarget && (vaLo > 0 || vaHi < ROWS - 1)) {
      const downAdd = vaLo > 0       ? buckets[vaLo - 1] : 0;
      const upAdd   = vaHi < ROWS - 1 ? buckets[vaHi + 1] : 0;
      if (downAdd >= upAdd && vaLo > 0)       { vaLo--; vaSum += buckets[vaLo]; }
      else if (vaHi < ROWS - 1)               { vaHi++; vaSum += buckets[vaHi]; }
      else if (vaLo > 0)                      { vaLo--; vaSum += buckets[vaLo]; }
      else break;
    }

    // ── Draw ────────────────────────────────────────────────────────────────
    const maxBarW  = 72;   // max pixels wide for the widest bar
    const barW     = maxVol > 0 ? Math.floor(maxBarW) : 0;
    const rightEdge = pane.x + pane.w;

    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    for (let i = 0; i < ROWS; i++) {
      if (!buckets[i]) continue;
      const price  = yMin + (i + 0.5) * step;
      const py     = ps.yToPix(price);
      const rowH   = Math.max(1, Math.ceil(ps.yToPix(yMin + i * step) - ps.yToPix(yMin + (i+1) * step)));
      const w      = Math.max(1, Math.round((buckets[i] / maxVol) * barW));

      const inVA   = i >= vaLo && i <= vaHi;
      const isPOC  = i === pocIdx;

      if (isPOC) {
        ctx.fillStyle = "rgba(255,200,0,0.75)";
      } else if (inVA) {
        ctx.fillStyle = "rgba(96,165,250,0.28)";
      } else {
        ctx.fillStyle = "rgba(148,163,184,0.14)";
      }
      ctx.fillRect(rightEdge - w, py - rowH, w, rowH);

      // Buy/sell split (green/red)
      const bW = Math.round((buyVol[i] / buckets[i]) * w);
      ctx.fillStyle = "rgba(34,197,94,0.35)";
      ctx.fillRect(rightEdge - w, py - rowH, bW, rowH);
      ctx.fillStyle = "rgba(239,68,68,0.35)";
      ctx.fillRect(rightEdge - w + bW, py - rowH, w - bW, rowH);
    }

    // POC label
    const pocPrice = yMin + (pocIdx + 0.5) * step;
    const pocY     = ps.yToPix(pocPrice);
    ctx.strokeStyle = "rgba(255,200,0,0.9)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pane.x, pocY);
    ctx.lineTo(rightEdge, pocY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();

    // POC price tag (outside clip)
    ctx.fillStyle   = "rgba(255,200,0,0.92)";
    ctx.font        = "bold 9.5px system-ui";
    ctx.fillText("POC " + pocPrice.toFixed(2), rightEdge - barW - 2, pocY - 3);
  }
}
