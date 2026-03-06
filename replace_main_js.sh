#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/turbogeek/vscode/charts"
MAIN="$ROOT/src/main.js"
ts="$(date +%Y%m%d_%H%M%S)"

[[ -f "$MAIN" ]] || { echo "ERROR: $MAIN not found"; exit 1; }
cp -a "$MAIN" "${MAIN}.bak_${ts}"
echo "==> Backed up src/main.js -> ${MAIN}.bak_${ts}"

cat > "$MAIN" <<'EOF'
import { Engine } from "./core/Engine.js";
import * as Providers from "./data/Providers.js";

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

// --- Provider selection (works with mockProvider OR makeMockProvider) ---
let provider = null;

// Preferred: a direct provider function
if (typeof Providers.mockProvider === "function") {
  provider = Providers.mockProvider;
} else if (typeof Providers.makeMockProvider === "function") {
  // makeMockProvider returns a provider function (possibly async)
  provider = Providers.makeMockProvider({ sampleUrl: "/sampleData.js" });
} else {
  throw new Error("No provider found. Expected Providers.js to export mockProvider or makeMockProvider.");
}

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
    hud.classList.toggle("hidden");
    queueResize();
  });
}

// --- Zoom buttons (generic: manipulate state.xDomain directly) ---
function zoomBy(factor) {
  const s = engine.state;
  if (!s || !s.xDomain) return;
  let [t0, t1] = s.xDomain;
  const span = t1 - t0;
  if (!(span > 0)) return;

  let newSpan = span * factor;
  const MIN = s.limits?.minSpanMs ?? (5 * 60 * 1000);
  const MAX = s.limits?.maxSpanMs ?? (30 * 24 * 60 * 60 * 1000);
  newSpan = Math.max(MIN, Math.min(MAX, newSpan));

  const anchor = (t0 + t1) * 0.5;
  s.xDomain = [anchor - newSpan / 2, anchor + newSpan / 2];
  engine.render?.();
}

document.getElementById("zoomIn")?.addEventListener("click", () => zoomBy(0.85));
document.getElementById("zoomOut")?.addEventListener("click", () => zoomBy(1.18));
document.getElementById("resetView")?.addEventListener("click", () => engine.resetView?.());

// --- Replay buttons (guarded) ---
document.getElementById("replayToggle")?.addEventListener("click", () => engine.replay?.toggle?.());
document.getElementById("stepForward")?.addEventListener("click", () => engine.replay?.step?.());

// --- Keyboard helpers ---
window.addEventListener("keydown", (e) => {
  if (e.key === "=" || e.key === "+") zoomBy(0.85);
  if (e.key === "-" || e.key === "_") zoomBy(1.18);
  if (e.key === "0") engine.resetView?.();
});

// --- Tiny status helper (optional) ---
if (statusEl && typeof engine.setStatus === "function") {
  // if engine already manages status, leave it alone
} else if (statusEl) {
  statusEl.textContent = "Ready";
}
EOF

echo "==> Wrote a clean src/main.js (no duplicate declarations)."
echo "Restart server:"
echo "  cd $ROOT && python3 -m http.server 5173"
echo "Then hard refresh: Ctrl+Shift+R"
