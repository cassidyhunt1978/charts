#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/turbogeek/vscode/charts"
ts="$(date +%Y%m%d_%H%M%S)"

cp -a "$ROOT/style.css" "$ROOT/style.css.bak_$ts" 2>/dev/null || true
cp -a "$ROOT/index.html" "$ROOT/index.html.bak_$ts" 2>/dev/null || true

cat > "$ROOT/style.css" <<'EOF'
:root{
  --bg:#0b0f17;
  --panel:#0e1624;
  --panel2:#0b1320;
  --fg:#e5e7eb;
  --muted:#94a3b8;
  --border:rgba(148,163,184,.14);

  --btnbg:rgba(148,163,184,.10);
  --btnbd:rgba(148,163,184,.16);
  --btnhover:rgba(148,163,184,.18);

  --radius:14px;
}

html,body{
  margin:0;
  height:100%;
  background:var(--bg);
  color:var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial;
}

#shell{
  height:100%;
  display:flex;
  justify-content:center;
  align-items:stretch;
  padding:10px;
  box-sizing:border-box;
}

#app{
  width:min(1280px, 100%);
  height:calc(100vh - 20px);
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:var(--radius);
  overflow:hidden;
  display:flex;
  flex-direction:column;
}

@media (max-width: 720px){
  #shell{ padding:0; }
  #app{
    width:100%;
    height:100vh;
    border-radius:0;
    border:0;
  }
}

#toolbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:10px 12px;
  border-bottom:1px solid var(--border);
  background:var(--panel2);
  position:relative;
  z-index:10;
}

#toolbar .left{
  display:flex;
  align-items:center;
  gap:10px;
  min-width: 220px;
}

.badge{
  width:9px; height:9px; border-radius:99px;
  background:#3b82f6;
  box-shadow: 0 0 12px rgba(59,130,246,.35);
}

.title{
  font-weight:800;
  letter-spacing:.2px;
}

.status{
  font-size:12px;
  color:var(--muted);
  opacity:.9;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  max-width: 520px;
}

#toolbar .right{
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
  justify-content:flex-end;
}

.sep{
  width:1px;
  height:18px;
  background:var(--border);
  margin:0 4px;
}

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

@media (max-width: 720px){
  .btn{ padding:10px 12px; border-radius:12px; }
  .sep{ display:none; }
}

#hud{
  border-bottom:1px solid var(--border);
  background:#0b1320;
  position:relative;
  z-index:9;
}
#hud.hidden{ display:none; }

#legend{
  padding:8px 12px;
  font-size:12px;
  line-height:1.35;
  color:var(--fg);
  max-height:120px;
  overflow:auto;
}

#chartWrap{
  flex:1;
  min-height:0;
  position:relative;
  background:#0b0f17;
}

#canvas{
  width:100%;
  height:100%;
  display:block;
  background:#0b0f17;
  touch-action:none; /* critical for mobile interactions */
}
EOF

cat > "$ROOT/index.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>MarketMind Terminal Engine</title>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <div id="shell">
    <div id="app">
      <div id="toolbar">
        <div class="left">
          <span class="badge"></span>
          <span class="title">MarketMind</span>
          <span id="status" class="status"></span>
        </div>

        <div class="right">
          <button id="zoomOut" class="btn pill" title="Zoom out">−</button>
          <button id="zoomIn" class="btn pill" title="Zoom in">+</button>
          <button id="resetView" class="btn" title="Reset view">Reset</button>

          <div class="sep"></div>

          <button id="replayToggle" class="btn" title="Toggle replay">Replay</button>
          <button id="stepForward" class="btn" title="Step">Step</button>

          <div class="sep"></div>

          <button id="hudToggle" class="btn" title="Show/Hide HUD">HUD</button>
        </div>
      </div>

      <div id="hud">
        <div id="legend"></div>
      </div>

      <div id="chartWrap">
        <canvas id="canvas"></canvas>
      </div>
    </div>
  </div>

  <script type="module" src="./src/main.js"></script>
</body>
</html>
EOF

echo "==> Applied Option A skin."
echo "Restart:"
echo "  cd $ROOT && python3 -m http.server 5173"
echo "Hard refresh: Ctrl+Shift+R"
