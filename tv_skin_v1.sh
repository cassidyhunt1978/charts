#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/turbogeek/vscode/charts"
ts="$(date +%Y%m%d_%H%M%S)"

backup(){ [[ -f "$1" ]] && cp -a "$1" "$1.bak_$ts"; }

echo "==> Backing up index.html + style.css..."
backup "$ROOT/index.html"
backup "$ROOT/style.css"

echo "==> Writing TradingView-ish index.html (same IDs)..."
cat > "$ROOT/index.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>MarketMind Terminal</title>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <div id="shell">
    <div id="app">
      <header id="topbar">
        <div class="tb-left">
          <div class="pair">
            <span class="dot"></span>
            <span class="pair-title">MarketMind</span>
            <span class="pair-sub" id="status">Ready</span>
          </div>
        </div>

        <div class="tb-right">
          <div class="group">
            <button id="zoomOut" class="btn pill" title="Zoom out">−</button>
            <button id="zoomIn" class="btn pill" title="Zoom in">+</button>
            <button id="resetView" class="btn pill" title="Reset">Reset</button>
          </div>

          <div class="divider"></div>

          <div class="group">
            <button id="replayToggle" class="btn" title="Replay">Replay</button>
            <button id="stepForward" class="btn" title="Step">Step</button>
          </div>

          <div class="divider"></div>

          <button id="hudToggle" class="btn" title="Toggle HUD">HUD</button>
        </div>
      </header>

      <!-- Compact HUD strip: doesn’t feel like a wall of text -->
      <section id="hud">
        <div id="legend"></div>
      </section>

      <main id="chartWrap">
        <canvas id="canvas"></canvas>
      </main>
    </div>
  </div>

  <script type="module" src="./src/main.js"></script>
</body>
</html>
EOF

echo "==> Writing TradingView-ish style.css..."
cat > "$ROOT/style.css" <<'EOF'
:root{
  /* TV-ish palette */
  --bg0:#0b1220;
  --bg1:#0a0f1a;
  --panel:#0f172a;
  --panel2:rgba(15,23,42,.55);

  --fg:#e5e7eb;
  --muted:rgba(148,163,184,.82);
  --border:rgba(148,163,184,.14);

  --btnbg:rgba(148,163,184,.10);
  --btnbd:rgba(148,163,184,.16);
  --btnhover:rgba(148,163,184,.18);

  --blue:#2f6bff;
  --radius:16px;
}

html,body{
  margin:0;
  height:100%;
  background:linear-gradient(180deg, var(--bg0), var(--bg1));
  color:var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, "Apple Color Emoji","Segoe UI Emoji";
}

#shell{
  height:100%;
  display:flex;
  justify-content:center;
  align-items:stretch;
  padding:12px;
  box-sizing:border-box;
}

#app{
  width:min(1280px, 100%);
  height:calc(100vh - 24px);
  border:1px solid var(--border);
  border-radius:var(--radius);
  overflow:hidden;
  display:flex;
  flex-direction:column;
  background:rgba(8,12,20,.75);
  backdrop-filter: blur(10px);
}

/* Mobile full-bleed */
@media (max-width: 720px){
  #shell{ padding:0; }
  #app{
    width:100%;
    height:100vh;
    border-radius:0;
    border:0;
  }
}

/* Top bar */
#topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:10px 12px;
  background:rgba(10,15,26,.92);
  border-bottom:1px solid var(--border);
  position:relative;
  z-index:10;
}

.tb-left{ display:flex; align-items:center; gap:10px; min-width: 240px; }
.pair{ display:flex; align-items:baseline; gap:10px; min-width:0; }
.dot{
  width:8px; height:8px; border-radius:99px;
  background: radial-gradient(circle at 30% 30%, #6ea8ff, var(--blue));
  box-shadow: 0 0 14px rgba(47,107,255,.35);
}
.pair-title{ font-weight:800; letter-spacing:.2px; }
.pair-sub{
  font-size:12px;
  color:var(--muted);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  max-width: 520px;
}

.tb-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
.group{ display:flex; gap:8px; align-items:center; }
.divider{ width:1px; height:18px; background:var(--border); }

.btn{
  padding:7px 10px;
  border-radius:10px;
  border:1px solid var(--btnbd);
  background:var(--btnbg);
  color:var(--fg);
  cursor:pointer;
  font-weight:700;
  user-select:none;
}
.btn:hover{ background:var(--btnhover); }
.btn:active{ transform:translateY(1px); }

.pill{ border-radius:999px; }

/* Make buttons easier on touch devices */
@media (max-width: 720px){
  .btn{ padding:10px 12px; border-radius:12px; }
  .divider{ display:none; }
}

/* HUD strip */
#hud{
  border-bottom:1px solid var(--border);
  background:linear-gradient(180deg, rgba(15,23,42,.52), rgba(15,23,42,.30));
  position:relative;
  z-index:9;
}
#hud.hidden{ display:none; }

/* Compact, readable legend */
#legend{
  padding:8px 12px;
  font-size:12px;
  line-height:1.35;
  color:var(--fg);
  max-height:120px;
  overflow:auto;
}

/* Chart */
#chartWrap{
  flex:1;
  min-height:0;
  position:relative;
}

#canvas{
  width:100%;
  height:100%;
  display:block;
  background: radial-gradient(1200px 700px at 50% 0%, rgba(47,107,255,.06), transparent 60%), #0b1220;
}
EOF

echo "==> Done."
echo "Restart:"
echo "  cd $ROOT && python3 -m http.server 5173"
echo "Hard refresh: Ctrl+Shift+R"
