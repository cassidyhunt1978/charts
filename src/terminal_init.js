/**
 * terminal_init.js
 * Importable entry point for embedding the MarketMind chart terminal
 * inside another page's modal. Called by the trading app's showChart().
 *
 * Usage:
 *   const { initChartTerminal, destroyChartTerminal } = await import('/chart-terminal/src/terminal_init.js');
 *   await initChartTerminal('ETH');
 */

import { Engine }                       from "./core/Engine.js";
import { fetchSymbols, makeLiveProvider } from "./data/LiveProvider.js";

let _engine      = null;
let _resizeObs   = null;

/** Tear down the current engine and observers (called on modal close). */
export function destroyChartTerminal() {
  if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
  if (_engine) { _engine.destroy?.(); _engine = null; }
  window._engine      = null;
  window._chartEngine = null;
}

/**
 * Boot (or re-init) the MarketMind terminal inside the currently-rendered
 * chart_terminal.html modal fragment. Safe to call multiple times — each
 * call tears down the previous engine and starts fresh.
 *
 * @param {string} symbol  Symbol to pre-select, e.g. "ETH"
 */
export async function initChartTerminal(symbol) {
  destroyChartTerminal();

  const canvas    = document.getElementById("canvas");
  const legend    = document.getElementById("legend");
  const statusEl  = document.getElementById("status");
  const hud       = document.getElementById("hud");
  const symbolSel = document.getElementById("symbolSelect");
  const daysSel   = document.getElementById("daysSelect");
  const toolbar   = document.getElementById("toolbar");

  if (!canvas) { console.error("[terminal_init] #canvas not found"); return; }

  // ── Engine ─────────────────────────────────────────────────────────────────
  const provider = makeLiveProvider(symbol || "BTC", 30);
  try {
    _engine = new Engine(canvas, legend, statusEl, { provider });
  } catch {
    _engine = new Engine(canvas, legend, { provider });
  }
  window._engine      = _engine;   // for alert-panel inline callbacks
  window._chartEngine = _engine;

  const r = _engine.start?.();
  if (r && typeof r.then === "function") await r;

  // ── Symbol dropdown ─────────────────────────────────────────────────────────
  if (symbolSel) {
    try {
      const symbols = await fetchSymbols();
      symbolSel.innerHTML = "";
      symbols.forEach(s => {
        const opt       = document.createElement("option");
        opt.value       = s.symbol;
        opt.textContent = s.symbol;
        opt.title       = `${s.name} (${s.exchange})`;
        if (s.symbol === symbol) opt.selected = true;
        symbolSel.appendChild(opt);
      });
    } catch {
      symbolSel.innerHTML = `<option value="${symbol}" selected>${symbol}</option>`;
    }

    const initSym  = symbolSel.value || symbol;
    const initDays = +(daysSel?.value ?? 30);
    if (initSym) _engine.loadSymbol?.(initSym, initDays);

    function reloadSymbol() {
      const sym  = symbolSel.value;
      const days = +(daysSel?.value ?? 7);
      if (sym) _engine.loadSymbol?.(sym, days);
    }
    symbolSel.addEventListener("change", reloadSymbol);
    if (daysSel) daysSel.addEventListener("change", reloadSymbol);
  }

  // ── Resize observer ─────────────────────────────────────────────────────────
  try {
    const chartWrap = document.getElementById("chartWrap");
    if (chartWrap) {
      _resizeObs = new ResizeObserver(() => {
        if (_engine) { _engine.resize?.() || _engine.render?.(); }
      });
      _resizeObs.observe(chartWrap);
      if (hud) _resizeObs.observe(hud);
    }
  } catch { /* ignore */ }

  // ── HUD toggle ──────────────────────────────────────────────────────────────
  document.getElementById("hudToggle")?.addEventListener("click", () => {
    if (!hud) return;
    if (hud.classList.contains("hidden")) {
      hud.classList.remove("hidden", "expanded");
    } else if (hud.classList.contains("expanded")) {
      hud.classList.remove("expanded"); hud.classList.add("hidden");
    } else {
      hud.classList.add("expanded");
    }
    _engine?.resize?.();
  });

  // ── Zoom / Reset ────────────────────────────────────────────────────────────
  document.getElementById("zoomIn")?.addEventListener("click",    () => _engine.zoomBy?.(0.82));
  document.getElementById("zoomOut")?.addEventListener("click",   () => _engine.zoomBy?.(1.22));
  document.getElementById("resetView")?.addEventListener("click", () => _engine.resetView?.());

  // ── Timeframe buttons ───────────────────────────────────────────────────────
  const ivGroup = document.getElementById("ivGroup");
  if (ivGroup) {
    ivGroup.addEventListener("click", e => {
      const btn = e.target.closest("[data-iv]");
      if (!btn) return;
      const iv = btn.dataset.iv;
      ivGroup.querySelectorAll("[data-iv]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _engine.setTimeframe?.(iv);
    });
  }

  // ── Replay ──────────────────────────────────────────────────────────────────
  document.getElementById("replayToggle")?.addEventListener("click", () => _engine.replay?.toggle?.());
  document.getElementById("stepForward")?.addEventListener("click",  () => _engine.replay?.step?.());

  // ── Stats / Export ──────────────────────────────────────────────────────────
  document.getElementById("statsBtn")?.addEventListener("click",  () => _engine.showStats?.());
  document.getElementById("exportBtn")?.addEventListener("click", () => _engine.exportForAI?.());

  // ── Backtest / Journal / Alerts ─────────────────────────────────────────────
  document.getElementById("backtestBtn")?.addEventListener("click", () => _engine.runBacktest?.());
  document.getElementById("journalBtn")?.addEventListener("click",  () => _engine.showJournal?.());
  document.getElementById("alertsBtn")?.addEventListener("click",   () => _engine.showAlerts?.());

  // ── Stream ──────────────────────────────────────────────────────────────────
  document.getElementById("streamBtn")?.addEventListener("click", () => _engine.toggleStream?.());

  // ── Drawing tools ───────────────────────────────────────────────────────────
  document.getElementById("hlineBtn")?.addEventListener("click",       () => _engine.setDrawingMode?.("hline"));
  document.getElementById("trendlineBtn")?.addEventListener("click",   () => _engine.setDrawingMode?.("trendline"));
  document.getElementById("clearDrawingsBtn")?.addEventListener("click", () => _engine.clearDrawings?.());

  // ── Indicators ──────────────────────────────────────────────────────────────
  document.getElementById("rsiToggle")?.addEventListener("click",  () => { _engine.toggleIndicator?.("rsi");  document.getElementById("rsiToggle")?.classList.toggle("ind-active");  });
  document.getElementById("bbToggle")?.addEventListener("click",   () => { _engine.toggleIndicator?.("bb");   document.getElementById("bbToggle")?.classList.toggle("ind-active");   });
  document.getElementById("vwapToggle")?.addEventListener("click", () => { _engine.toggleIndicator?.("vwap"); document.getElementById("vwapToggle")?.classList.toggle("ind-active"); });
  document.getElementById("vpvrToggle")?.addEventListener("click", () => { _engine.toggleVPVR?.();            document.getElementById("vpvrToggle")?.classList.toggle("ind-active"); });
  document.getElementById("smcToggle")?.addEventListener("click",  () => { _engine.toggleSMC?.();             document.getElementById("smcToggle")?.classList.toggle("ind-active");  });

  // ── Signal helpers ──────────────────────────────────────────────────────────
  document.getElementById("autoSignalsBtn")?.addEventListener("click", () => _engine.autoPlaceSignals?.());
  document.getElementById("clearSignalsBtn")?.addEventListener("click", () => {
    if (confirm("Remove all placed signals?")) _engine.clearSignals?.();
  });

  // ── Phase-12 analysis panels ────────────────────────────────────────────────
  document.getElementById("mtfBtn")?.addEventListener("click",         () => _engine.toggleMTF?.());
  document.getElementById("riskBtn")?.addEventListener("click",        () => _engine.toggleRiskMode?.());
  document.getElementById("signalRulesBtn")?.addEventListener("click", () => _engine.toggleSignalEditor?.());
  document.getElementById("optimizerBtn")?.addEventListener("click",   () => _engine.toggleOptimizerPanel?.());

  // ── Toolbar collapse ─────────────────────────────────────────────────────────
  document.getElementById("tbCollapse")?.addEventListener("click", () => {
    toolbar?.classList.toggle("tb-compact");
  });

  // ── Tools dropdown ───────────────────────────────────────────────────────────
  const toolsBtn      = document.getElementById("toolsBtn");
  const toolsDropdown = document.getElementById("toolsDropdown");
  if (toolsBtn && toolsDropdown) {
    toolsBtn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = !toolsDropdown.hidden;
      if (!isOpen) {
        const r = toolsBtn.getBoundingClientRect();
        toolsDropdown.style.left     = r.left + "px";
        toolsDropdown.style.top      = (r.bottom + 6) + "px";
        toolsDropdown.style.maxWidth = (window.innerWidth - r.left - 12) + "px";
      }
      toolsDropdown.hidden = isOpen;
      toolsBtn.classList.toggle("active", !isOpen);
    });
    document.addEventListener("click", e => {
      if (!toolsDropdown.hidden && !document.getElementById("toolsWrap")?.contains(e.target)) {
        toolsDropdown.hidden = true;
        toolsBtn.classList.remove("active");
      }
    });
    toolsDropdown.addEventListener("click", e => {
      const btn = e.target.closest(".btn");
      if (btn && btn.id !== "toolsBtn") {
        setTimeout(() => { toolsDropdown.hidden = true; toolsBtn.classList.remove("active"); }, 150);
      }
    });
  }
}
