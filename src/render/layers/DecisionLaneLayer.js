/**
 * DecisionLaneLayer
 *
 * Two-row signal strip above the price pane:
 *
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  Ensemble │  ▲  ▼       ▲    ▼          ▲              │  ← auto signals from events
 *  │  My Signal│  ▲                 ▼                        │  ← user-placed draggable marks
 *  └─────────────────────────────────────────────────────────┘
 *
 * Ensemble signals come from scene.events (any stage; kind drives colour).
 * My Signal markers are scene.markers with pane === "lane" (draggable).
 * Both sets are exported for AI pattern analysis.
 */

const GUTTER  = 78;          // px width of left label column
const BUY_COL  = "#26a69a";  // teal  (up / entry)
const SELL_COL = "#ef5350";  // red   (down / exit)
const DIM_COL  = "rgba(255,255,255,.07)";

export class DecisionLaneLayer {
  draw(ctx, scene) {
    const pane = scene.panes.lane;
    if (!pane) return;

    const [t0, t1] = scene.xDomain;
    const span = t1 - t0;
    if (!(span > 0)) return;

    const W = pane.w;
    const H = pane.h;
    const px = pane.x;
    const py = pane.y;

    /* ── background ─────────────────────────────────────────── */
    ctx.fillStyle = "#181c27";
    ctx.fillRect(px, py, W, H);

    /* ── gutter background ───────────────────────────────────── */
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.fillRect(px, py, GUTTER, H);

    /* ── thin horizontal mid-divider ────────────────────────── */
    const rowH  = H / 2;
    const midY  = py + rowH;
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px,          midY);
    ctx.lineTo(px + W,      midY);
    ctx.stroke();

    /* ── gutter / chart separator ──────────────────────────── */
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.beginPath();
    ctx.moveTo(px + GUTTER, py);
    ctx.lineTo(px + GUTTER, py + H);
    ctx.stroke();

    /* ── row labels ─────────────────────────────────────────── */
    ctx.font      = "bold 10px system-ui";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "rgba(255,255,255,.38)";
    ctx.fillText("Ensemble", px + 6, py + rowH * 0.5);

    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.fillText("My Signal", px + 6, py + rowH * 1.5);

    /* ── helpers ─────────────────────────────────────────────── */
    // tToX must be identical to every other pane (maps t0→pane.x, t1→pane.x+pane.w)
    // so that signal triangles align pixel-perfectly with candles below them.
    // The GUTTER is purely cosmetic (label area); we clip signal drawing to its right edge.
    const chartX0 = px + GUTTER;
    const tToX    = (t) => px + ((t - t0) / span) * W;

    // Draw a small filled triangle
    //   dir: 1 = pointing up (buy), -1 = pointing down (sell)
    const drawTriangle = (cx, cy, size, col, dir, glow) => {
      if (glow) {
        ctx.shadowColor = col;
        ctx.shadowBlur  = 6;
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      if (dir > 0) {
        ctx.moveTo(cx,        cy - size);
        ctx.lineTo(cx - size * 0.8, cy + size * 0.55);
        ctx.lineTo(cx + size * 0.8, cy + size * 0.55);
      } else {
        ctx.moveTo(cx,        cy + size);
        ctx.lineTo(cx - size * 0.8, cy - size * 0.55);
        ctx.lineTo(cx + size * 0.8, cy - size * 0.55);
      }
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    /* ── Row 0: Ensemble auto-signals ────────────────────────── */
    const ey = py + rowH * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartX0, py, W - GUTTER, H);
    ctx.clip();
    for (const e of scene.events) {
      if (e.t < t0 || e.t > t1) continue;
      const x   = tToX(e.t);
      const isBuy = (e.kind === "signal" || e.kind === "buy" || e.side === "buy");
      const col   = isBuy ? BUY_COL : SELL_COL;
      const dir   = isBuy ? 1 : -1;
      drawTriangle(x, ey, 5, col, dir, false);
    }

    /* ── Row 1: User "My Signal" draggable markers ───────────── */
    const uy = py + rowH * 1.5;
    for (const m of scene.markers) {
      if (m.pane !== "lane") continue;
      if (m.t < t0 || m.t > t1) continue;

      const x   = tToX(m.t);
      const isBuy = m.kind === "buy";
      const col   = isBuy ? BUY_COL : SELL_COL;
      const dir   = isBuy ? 1 : -1;
      const selected = scene.state.selectedMarkerId === m.id;

      // Larger target for dragging (size 7 = ~14px tall)
      drawTriangle(x, uy, 7, col, dir, selected);

      // Thin outline ring so it reads against any background
      ctx.strokeStyle = "rgba(0,0,0,.45)";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      if (dir > 0) {
        ctx.moveTo(x,          uy - 7);
        ctx.lineTo(x - 5.6,   uy + 3.85);
        ctx.lineTo(x + 5.6,   uy + 3.85);
      } else {
        ctx.moveTo(x,          uy + 7);
        ctx.lineTo(x - 5.6,   uy - 3.85);
        ctx.lineTo(x + 5.6,   uy - 3.85);
      }
      ctx.closePath();
      ctx.stroke();

      // Store screen coords for hit-testing (use real x so drag works correctly)
      m._screenX    = x;
      m._screenY    = uy;
      m._screenPane = "lane";
    }
    ctx.restore(); // end clip to chart area (right of gutter)
  }
}
