/**
 * RiskCalculator — On-chart Risk / Position Size tool
 *
 * Usage:
 *   1. engine.setRiskMode(true)   → click stop price on chart
 *   2. Second click               → entry/target price
 *   → Panel auto-renders R:R, position size, $ at risk
 *
 * Integrates with InteractionEngine click handler via state.riskMode.
 */

const PADDING = 180;   // px from right edge for the stats panel

export class RiskCalculator {
  constructor() {
    this._stop   = null;   // price level clicked first
    this._target = null;   // price level clicked second
  }

  /** Called by InteractionEngine with converted price */
  handleClick(price, state) {
    if (!state.riskMode) return false;
    if (state.risk.step === 0) {
      this._stop = price;
      state.risk.stopPrice = price;
      state.risk.step = 1;
      return true;
    }
    if (state.risk.step === 1) {
      this._target = price;
      state.risk.targetPrice = price;
      state.risk.step = 2;
      return true;
    }
    // Third click resets
    this._stop   = null;
    this._target = null;
    state.risk.step   = 0;
    state.risk.stopPrice   = null;
    state.risk.targetPrice = null;
    return true;
  }

  deactivate(state) {
    this._stop   = null;
    this._target = null;
    state.riskMode = false;
    state.risk.step = 0;
    state.risk.stopPrice   = null;
    state.risk.targetPrice = null;
  }

  /** Draw into the price pane canvas */
  draw(ctx, scene) {
    if (!scene.state.riskMode) return;
    const ps   = scene._priceScale;
    const pane = scene.panes.price;
    if (!ps || !pane) return;

    const risk = scene.state.risk;

    // Current cursor price — derived from cursorY (set by InteractionEngine onMove)
    const cursorY = scene.state.cursorY;
    const enter   = (cursorY != null && pane &&
                     cursorY >= pane.y && cursorY <= pane.y + pane.h)
                    ? ps.pixToY(cursorY)
                    : null;

    // ── Step 0: waiting for stop click ────────────────────────────────────
    if (risk.step === 0) {
      if (!enter) return;
      this._drawHLine(ctx, pane, ps, enter, "#f97316", "STOP (click)");
      return;
    }

    // ── Step 1: stop set, waiting for target ──────────────────────────────
    const stopPrice = risk.stopPrice;
    this._drawHLine(ctx, pane, ps, stopPrice, "#ef4444", "STOP " + stopPrice.toFixed(2));

    if (risk.step === 1) {
      if (!enter) return;
      this._drawHLine(ctx, pane, ps, enter, "#22c55e", "TARGET (click)");
      // Draw provisional R:R
      this._drawRRPanel(ctx, pane, ps, stopPrice, enter, risk);
      return;
    }

    // ── Step 2: both set ──────────────────────────────────────────────────
    const targetPrice = risk.targetPrice;
    this._drawHLine(ctx, pane, ps, stopPrice,   "#ef4444", "STOP " + stopPrice.toFixed(2));
    this._drawHLine(ctx, pane, ps, targetPrice, "#22c55e", "TARGET " + targetPrice.toFixed(2));

    // Shaded zone between stop and target
    const yt = Math.min(ps.yToPix(stopPrice), ps.yToPix(targetPrice));
    const yb = Math.max(ps.yToPix(stopPrice), ps.yToPix(targetPrice));
    ctx.save();
    ctx.fillStyle = targetPrice > stopPrice ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)";
    ctx.fillRect(pane.x, yt, pane.w, yb - yt);
    ctx.restore();

    this._drawRRPanel(ctx, pane, ps, stopPrice, targetPrice, risk);
  }

  _drawHLine(ctx, pane, ps, price, color, label) {
    const y = ps.yToPix(price);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(pane.x, y);
    ctx.lineTo(pane.x + pane.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font      = "bold 10px system-ui";
    ctx.fillText(label, pane.x + 8, y - 3);
    ctx.restore();
  }

  _drawRRPanel(ctx, pane, ps, stopPrice, targetPrice, risk) {
    const stopDist = Math.abs(targetPrice - stopPrice);
    if (!stopDist) return;

    const acct    = risk.accountSize ?? 10000;
    const riskPct = risk.riskPct     ?? 1.0;
    const dollarRisk = acct * (riskPct / 100);
    const qty     = dollarRisk / stopDist;
    const rr      = stopDist; // reference, R:R meaningful when entry is between stop & target
    const rewardDollars = qty * stopDist;

    // Panel in top-right of price pane
    const pw  = 185, ph = 98;
    const px  = pane.x + pane.w - pw - 6;
    const py  = pane.y + 6;

    ctx.save();
    ctx.fillStyle   = "rgba(15,23,42,0.88)";
    ctx.strokeStyle = "rgba(99,102,241,0.7)";
    ctx.lineWidth   = 1;
    this._roundRect(ctx, px, py, pw, ph, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#e2e8f0";
    ctx.font      = "bold 10px system-ui";
    ctx.fillText("RISK CALC", px + 8, py + 16);

    ctx.font      = "9.5px system-ui";
    ctx.fillStyle = "#94a3b8";
    const lines = [
      ["Account Size", "$" + acct.toLocaleString()],
      ["Risk %",       riskPct.toFixed(1) + "%"],
      ["$ at Risk",    "$" + dollarRisk.toFixed(2)],
      ["Stop Distance", stopDist.toFixed(2)],
      ["Position Size", qty.toFixed(2) + " units"],
    ];
    lines.forEach(([k, v], i) => {
      ctx.fillStyle = "#64748b";
      ctx.fillText(k, px + 8, py + 30 + i * 13);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillText(v, px + pw - 8 - ctx.measureText(v).width, py + 30 + i * 13);
    });
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
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
}
