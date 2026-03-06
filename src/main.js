import { Engine } from "./core/Engine.js";
import * as Providers from "./data/Providers.js";
import { fetchSymbols, makeLiveProvider } from "./data/LiveProvider.js";
import { Watchlist } from "./ui/Watchlist.js";

// --- DOM bindings (robust across UI revisions) ---
const canvas =
  document.getElementById("canvas") ||
  document.getElementById("chart") ||
  document.querySelector("canvas");

if (!canvas) {
  throw new Error("Canvas element not found. Expected <canvas id='canvas'> in index.html");
}

const legend =
  document.getElementById("legend") ||
  document.getElementById("hudBody") ||
  null;

const statusEl =
  document.getElementById("status") ||
  null;

const hud =
  document.getElementById("hud") ||
  null;


// default: HUD visible, single-line (no extra class needed with new CSS)
// --- Provider selection ---
// Default: live data from the API. Falls back to mock if API is unreachable.
let provider = makeLiveProvider("BTC", 30);

// --- Engine construction (supports both constructor signatures) ---
let engine = null;
try {
  // Newer signature: (canvas, legend, statusEl, config)
  engine = new Engine(canvas, legend, statusEl, { provider });
} catch (e1) {
  try {
    // Older signature variants sometimes omit statusEl
    engine = new Engine(canvas, legend, { provider });
  } catch (e2) {
    console.error("Engine ctor failed (new signature):", e1);
    console.error("Engine ctor failed (old signature):", e2);
    throw e2;
  }
}

// --- Start (supports sync or async start) ---
{
  const r = engine.start?.();
  if (r && typeof r.then === "function") await r;
}

// Expose for alert panel inline callbacks
window._engine = engine;

// --- Populate symbol dropdown from live API ---
const symbolSelect = document.getElementById("symbolSelect");
const daysSelect   = document.getElementById("daysSelect");

// Read optional symbol from URL query string, e.g. /charts/?symbol=ETH
const _urlSym = new URLSearchParams(window.location.search).get("symbol") || null;

if (symbolSelect) {
  fetchSymbols()
    .then(symbols => {
      symbolSelect.innerHTML = "";
      const preferredSym = _urlSym || "BTC";
      symbols.forEach(s => {
        const opt = document.createElement("option");
        opt.value       = s.symbol;
        opt.textContent = s.symbol;
        opt.title       = `${s.name} (${s.exchange})`;
        if (s.symbol === preferredSym) opt.selected = true;
        symbolSelect.appendChild(opt);
      });
      // Always reload using the user's current days selection
      // (the engine started with hardcoded 7d; this replaces it correctly)
      const initSym  = symbolSelect.value || (symbols[0]?.symbol ?? "");
      const initDays = +(daysSelect?.value ?? 7);
      if (initSym) engine.loadSymbol?.(initSym, initDays);
    })
    .catch(err => {
      console.warn("fetchSymbols failed — API may be unavailable:", err);
      symbolSelect.innerHTML = '<option value="">Mock (offline)</option>';
    });

  // On symbol or days change → reload from live API
  function reloadSymbol() {
    const sym  = symbolSelect.value;
    const days = +(daysSelect?.value ?? 7);
    if (sym) engine.loadSymbol?.(sym, days);
  }
  symbolSelect.addEventListener("change", reloadSymbol);
  if (daysSelect) daysSelect.addEventListener("change", reloadSymbol);
}

// --- Keep interaction mapping correct when layout changes (HUD expand/collapse, mobile, fonts) ---
let _resizeQueued = false;
function queueResize() {
  if (_resizeQueued) return;
  _resizeQueued = true;
  requestAnimationFrame(() => {
    _resizeQueued = false;
    if (engine.resize) engine.resize();
    else engine.render?.();
  });
}

try {
  const hudObs = new ResizeObserver(() => queueResize());
  if (hud) hudObs.observe(hud);
  const appEl = document.getElementById("app");
  const appObs = new ResizeObserver(() => queueResize());
  if (appEl) appObs.observe(appEl);
} catch {
  // ResizeObserver not available (rare); ignore
}

// --- HUD toggle (if button exists) ---
const hudBtn = document.getElementById("hudToggle");
if (hudBtn && hud) {
  hudBtn.addEventListener("click", () => {
    // Cycle HUD between compact and expanded (doesn't block interactions)
    if (!hud) return;
    // Cycle: visible (collapsed) → expanded → hidden → visible
    if (hud.classList.contains("hidden")) {
      hud.classList.remove("hidden");
      hud.classList.remove("expanded");
    } else if (hud.classList.contains("expanded")) {
      hud.classList.remove("expanded");
      hud.classList.add("hidden");
    } else {
      hud.classList.add("expanded");
    }
    // keep interaction mapping correct after height changes
    if (typeof queueResize === "function") queueResize();
  });
}

document.getElementById("zoomIn")?.addEventListener("click",  () => engine.zoomBy?.(0.82));
document.getElementById("zoomOut")?.addEventListener("click", () => engine.zoomBy?.(1.22));
document.getElementById("resetView")?.addEventListener("click", () => engine.resetView?.());

// --- Timeframe interval buttons ---
const ivGroup = document.getElementById("ivGroup");
if (ivGroup) {
  ivGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-iv]");
    if (!btn) return;
    const iv = btn.dataset.iv;
    ivGroup.querySelectorAll("[data-iv]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    engine.setTimeframe?.(iv);
  });
}

// --- Replay buttons (guarded) ---
document.getElementById("replayToggle")?.addEventListener("click", () => engine.replay?.toggle?.());
document.getElementById("stepForward")?.addEventListener("click",  () => engine.replay?.step?.());

// --- Stats + Export AI buttons ---
document.getElementById("statsBtn")?.addEventListener("click",  () => engine.showStats?.());
document.getElementById("exportBtn")?.addEventListener("click", () => engine.exportForAI?.());

// --- Backtest / Journal / Alerts ---
document.getElementById("backtestBtn")?.addEventListener("click", () => engine.runBacktest?.());
document.getElementById("journalBtn")?.addEventListener("click",  () => engine.showJournal?.());
document.getElementById("alertsBtn")?.addEventListener("click",   () => engine.showAlerts?.());

// --- Stream toggle ---
document.getElementById("streamBtn")?.addEventListener("click", () => engine.toggleStream?.());

// --- Drawing tools ---
document.getElementById("hlineBtn")?.addEventListener("click",       () => engine.setDrawingMode?.("hline"));
document.getElementById("trendlineBtn")?.addEventListener("click",   () => engine.setDrawingMode?.("trendline"));
document.getElementById("clearDrawingsBtn")?.addEventListener("click", () => engine.clearDrawings?.());

// --- Indicator toggles ---
document.getElementById("rsiToggle")?.addEventListener("click",  () => { engine.toggleIndicator?.("rsi");  document.getElementById("rsiToggle")?.classList.toggle("ind-active"); });
document.getElementById("bbToggle")?.addEventListener("click",   () => { engine.toggleIndicator?.("bb");   document.getElementById("bbToggle")?.classList.toggle("ind-active");  });
document.getElementById("vwapToggle")?.addEventListener("click", () => { engine.toggleIndicator?.("vwap"); document.getElementById("vwapToggle")?.classList.toggle("ind-active"); });
document.getElementById("vpvrToggle")?.addEventListener("click", () => { engine.toggleVPVR?.();            document.getElementById("vpvrToggle")?.classList.toggle("ind-active"); });
document.getElementById("smcToggle")?.addEventListener("click",  () => { engine.toggleSMC?.();             document.getElementById("smcToggle")?.classList.toggle("ind-active");  });

// --- Signal helpers ---
document.getElementById("autoSignalsBtn")?.addEventListener("click", () => engine.autoPlaceSignals?.());
document.getElementById("clearSignalsBtn")?.addEventListener("click", () => {
  if (confirm("Remove all placed signals?")) engine.clearSignals?.();
});

// --- New Phase-12 buttons ---
document.getElementById("mtfBtn")?.addEventListener("click",         () => engine.toggleMTF?.());
document.getElementById("riskBtn")?.addEventListener("click",        () => engine.toggleRiskMode?.());
document.getElementById("signalRulesBtn")?.addEventListener("click", () => engine.toggleSignalEditor?.());
document.getElementById("optimizerBtn")?.addEventListener("click",   () => engine.toggleOptimizerPanel?.());

// ─── Toolbar collapse ───────────────────────────────────────────────────────
const toolbar = document.getElementById("toolbar");
document.getElementById("tbCollapse")?.addEventListener("click", () => {
  toolbar?.classList.toggle("tb-compact");
});

// ─── Tools dropdown ──────────────────────────────────────────────────────────
const toolsBtn      = document.getElementById("toolsBtn");
const toolsDropdown = document.getElementById("toolsDropdown");

toolsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !toolsDropdown.hidden;
  if (!isOpen) {
    // Position below the button, viewport-relative (escapes overflow clipping)
    const r = toolsBtn.getBoundingClientRect();
    toolsDropdown.style.left = r.left + "px";
    toolsDropdown.style.top  = (r.bottom + 6) + "px";
    // Clamp to viewport right edge
    toolsDropdown.style.maxWidth = (window.innerWidth - r.left - 12) + "px";
  }
  toolsDropdown.hidden = isOpen;
  toolsBtn.classList.toggle("active", !isOpen);
});

// Close on outside click
document.addEventListener("click", (e) => {
  if (!toolsDropdown?.hidden && !document.getElementById("toolsWrap")?.contains(e.target)) {
    toolsDropdown.hidden = true;
    toolsBtn?.classList.remove("active");
  }
});

// Close dropdown when any tool button inside is clicked
toolsDropdown?.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn");
  if (btn && btn.id !== "toolsBtn") {
    setTimeout(() => {
      toolsDropdown.hidden = true;
      toolsBtn?.classList.remove("active");
    }, 150);
  }
});

// ─── Command Palette ────────────────────────────────────────────────────────
const COMMANDS = [
  { icon: "↕",  label: "Toggle RSI",               shortcut: "",       action: () => { engine.toggleIndicator?.("rsi");  document.getElementById("rsiToggle")?.classList.toggle("ind-active"); } },
  { icon: "⊂",  label: "Toggle Bollinger Bands",    shortcut: "",       action: () => { engine.toggleIndicator?.("bb");   document.getElementById("bbToggle")?.classList.toggle("ind-active");  } },
  { icon: "~",  label: "Toggle VWAP",               shortcut: "",       action: () => { engine.toggleIndicator?.("vwap"); document.getElementById("vwapToggle")?.classList.toggle("ind-active"); } },
  { icon: "▓",  label: "Toggle Volume Profile",     shortcut: "",       action: () => { engine.toggleVPVR?.();            document.getElementById("vpvrToggle")?.classList.toggle("ind-active"); } },
  { icon: "📐", label: "Toggle Smart Money (SMC)",  shortcut: "",       action: () => { engine.toggleSMC?.();             document.getElementById("smcToggle")?.classList.toggle("ind-active");  } },
  { icon: "⏱",  label: "Multi-TF Confluence (MTF)", shortcut: "",       action: () => engine.toggleMTF?.() },
  { icon: "⚖",  label: "Risk / Position Calculator",shortcut: "",       action: () => engine.toggleRiskMode?.() },
  { icon: "—",  label: "Draw Horizontal Line",      shortcut: "H",      action: () => engine.setDrawingMode?.("hline") },
  { icon: "↗",  label: "Draw Trendline",            shortcut: "T",      action: () => engine.setDrawingMode?.("trendline") },
  { icon: "✕",  label: "Clear Drawings",            shortcut: "",       action: () => engine.clearDrawings?.() },
  { icon: "▲",  label: "Auto Place HL Signals",     shortcut: "",       action: () => engine.autoPlaceSignals?.() },
  { icon: "🗑",  label: "Clear Signals",             shortcut: "",       action: () => { if(confirm("Remove all signals?")) engine.clearSignals?.(); } },
  { icon: "▶",  label: "Toggle Replay",             shortcut: "",       action: () => engine.replay?.toggle?.() },
  { icon: "⏭",  label: "Step Replay Forward",       shortcut: "",       action: () => engine.replay?.step?.() },
  { icon: "📡", label: "Toggle Live Stream",         shortcut: "",       action: () => engine.toggleStream?.() },
  { icon: "📊", label: "Show P&L Stats",             shortcut: "",       action: () => engine.showStats?.() },
  { icon: "⚗",  label: "Run Backtest",               shortcut: "",       action: () => engine.runBacktest?.() },
  { icon: "⚙",  label: "Strategy Optimizer",         shortcut: "",       action: () => engine.toggleOptimizerPanel?.() },
  { icon: "📓", label: "Trade Journal",              shortcut: "",       action: () => engine.showJournal?.() },
  { icon: "🔔", label: "Alerts",                     shortcut: "",       action: () => engine.showAlerts?.() },
  { icon: "⬇",  label: "Export for AI",              shortcut: "",       action: () => engine.exportForAI?.() },
  { icon: "+",  label: "Zoom In",                   shortcut: "+",      action: () => engine.zoomBy?.(0.82) },
  { icon: "−",  label: "Zoom Out",                  shortcut: "−",      action: () => engine.zoomBy?.(1.22) },
  { icon: "↺",  label: "Reset View",                shortcut: "0",      action: () => engine.resetView?.() },
  { icon: "☰",  label: "Toggle Compact Mode",        shortcut: "Ctrl+\\",action: () => toolbar?.classList.toggle("tb-compact") },
  { icon: "🗂",  label: "Watchlist",                  shortcut: "",       action: () => document.getElementById("watchlistBtn")?.click() },
];

const cmdPalette  = document.getElementById("cmd-palette");
const cmdSearch   = document.getElementById("cmd-search");
const cmdList     = document.getElementById("cmd-list");
let cmdActive     = 0;
let cmdFiltered   = COMMANDS;

function openCmdPalette() {
  if (!cmdPalette) return;
  cmdPalette.classList.add("open");
  cmdPalette.setAttribute("aria-hidden", "false");
  cmdSearch.value = "";
  renderCmdList(COMMANDS);
  cmdSearch.focus();
}

function closeCmdPalette() {
  if (!cmdPalette) return;
  cmdPalette.classList.remove("open");
  cmdPalette.setAttribute("aria-hidden", "true");
}

function renderCmdList(items) {
  cmdFiltered = items;
  cmdActive   = 0;
  if (!cmdList) return;
  cmdList.innerHTML = items.map((c, i) => `
    <div class="cmd-item${i === 0 ? " active" : ""}" data-idx="${i}">
      <span class="cmd-item-icon">${c.icon}</span>
      <span class="cmd-item-label">${c.label}</span>
      ${c.shortcut ? `<span class="cmd-item-shortcut">${c.shortcut}</span>` : ""}
    </div>`).join("");

  cmdList.querySelectorAll(".cmd-item").forEach(el => {
    el.addEventListener("mouseenter", () => {
      cmdList.querySelectorAll(".cmd-item").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      cmdActive = +el.dataset.idx;
    });
    el.addEventListener("click", () => {
      cmdFiltered[+el.dataset.idx]?.action();
      closeCmdPalette();
    });
  });
}

cmdSearch?.addEventListener("input", () => {
  const q = cmdSearch.value.toLowerCase();
  renderCmdList(COMMANDS.filter(c => c.label.toLowerCase().includes(q)));
});

cmdSearch?.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cmdActive = Math.min(cmdActive + 1, cmdFiltered.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cmdActive = Math.max(cmdActive - 1, 0);
  } else if (e.key === "Enter") {
    cmdFiltered[cmdActive]?.action();
    closeCmdPalette();
    return;
  } else if (e.key === "Escape") {
    closeCmdPalette();
    return;
  }
  cmdList?.querySelectorAll(".cmd-item").forEach((el, i) => el.classList.toggle("active", i === cmdActive));
  cmdList?.querySelectorAll(".cmd-item")[cmdActive]?.scrollIntoView({ block: "nearest" });
});

// Close on backdrop click
cmdPalette?.addEventListener("click", (e) => {
  if (e.target === cmdPalette) closeCmdPalette();
});

document.getElementById("cmdPaletteBtn")?.addEventListener("click", openCmdPalette);

// --- Watchlist ---
const watchlistEl = document.getElementById("watchlist");
if (watchlistEl) {
  const watchlist = new Watchlist(watchlistEl, engine);
  watchlist.init();
  document.getElementById("watchlistBtn")?.addEventListener("click", () => watchlist.toggle());
}

// --- Keyboard helpers ---
window.addEventListener("keydown", (e) => {
  // Don't fire shortcuts when typing in an input
  const inInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;

  if (e.key === "=" || e.key === "+") { if (!inInput) engine.zoomBy?.(0.82); }
  if (e.key === "-" || e.key === "_") { if (!inInput) engine.zoomBy?.(1.22); }
  if (e.key === "0") { if (!inInput) engine.resetView?.(); }

  // Ctrl+P → command palette
  if ((e.ctrlKey || e.metaKey) && e.key === "p") {
    e.preventDefault();
    openCmdPalette();
  }

  // Ctrl+\ → compact toolbar
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    toolbar?.classList.toggle("tb-compact");
  }

  // Escape → close command palette
  if (e.key === "Escape" && cmdPalette?.classList.contains("open")) {
    closeCmdPalette();
  }
});

// --- Tiny status helper (optional) ---
if (statusEl && typeof engine.setStatus === "function") {
  // if engine already manages status, leave it alone
} else if (statusEl) {
  statusEl.textContent = "Ready";
}
