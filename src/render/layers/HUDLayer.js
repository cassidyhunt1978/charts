import { effectiveFill } from "../../util/execution.js";

export class HUDLayer {
  constructor(legendEl) { this.legendEl = legendEl; }

  draw(ctx, scene) {
    if (!this.legendEl) return;

    const b = scene.cursorBar;

    if (!b) {
      // No cursor — show symbol/timeframe only
      this.legendEl.innerHTML =
        `<span class="hud-sym">${scene.state.symbol}</span>` +
        `<span class="hud-tf">${scene.state.timeframe}</span>`;
      return;
    }

    const chg    = b.c - b.o;
    const pct    = ((chg / b.o) * 100).toFixed(2);
    const up     = chg >= 0;
    const col    = up ? "#26a69a" : "#ef5350";
    const sign   = up ? "+" : "";

    const s        = scene.state.settings;
    const mid      = b.c;
    const buyFill  = effectiveFill({ side:"buy",  mid, spreadBps:s.spreadBps, slippageBps:s.slippageBps, feeBps:s.feeBps });
    const sellFill = effectiveFill({ side:"sell", mid, spreadBps:s.spreadBps, slippageBps:s.slippageBps, feeBps:s.feeBps });

    const dt = new Date(b.t);
    const dateStr = dt.toLocaleString(undefined, {
      month:"short", day:"numeric",
      hour:"2-digit", minute:"2-digit"
    });

    this.legendEl.innerHTML =
      `<span class="hud-sym">${scene.state.symbol}</span>` +
      `<span class="hud-tf">${scene.state.timeframe}</span>` +
      `<span class="hud-sep"></span>` +
      kv("O",  b.o.toFixed(2)) +
      kv("H",  b.h.toFixed(2), "#26a69a") +
      kv("L",  b.l.toFixed(2), "#ef5350") +
      kv("C",  b.c.toFixed(2)) +
      `<span class="hud-chg" style="color:${col}">${sign}${chg.toFixed(2)}&thinsp;(${sign}${pct}%)</span>` +
      `<span class="hud-sep"></span>` +
      kv("Ask", buyFill.toFixed(2),  "#26a69a") +
      kv("Bid", sellFill.toFixed(2), "#ef5350") +
      `<span class="hud-sep"></span>` +
      `<span class="hud-date">${dateStr}</span>`;
  }
}

function kv(k, v, col) {
  const vstyle = col ? ` style="color:${col}"` : "";
  return `<span class="hud-kv"><span class="hud-key">${k}</span>` +
         `<span class="hud-val"${vstyle}>${v}</span></span>`;
}
