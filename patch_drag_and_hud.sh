#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/turbogeek/vscode/charts"
ts="$(date +%Y%m%d_%H%M%S)"

IE="$ROOT/src/interaction/InteractionEngine.js"
CSS="$ROOT/style.css"
MAIN="$ROOT/src/main.js"

for f in "$IE" "$CSS" "$MAIN"; do
  [[ -f "$f" ]] || { echo "ERROR: missing $f"; exit 1; }
  cp -a "$f" "$f.bak_$ts"
done

echo "==> 1) Patching InteractionEngine.js to preserve grab offset (no drag jump)..."

python3 - <<'PY'
import re, pathlib
p = pathlib.Path("/home/turbogeek/vscode/charts/src/interaction/InteractionEngine.js")
s = p.read_text(encoding="utf-8")

# Ensure we store last down coords (used to compute grab offset)
if "this._downX" not in s:
    s = re.sub(r'(this\._requestOlder\s*=\s*null;\s*)',
               r'\1\n    this._downX = 0;\n    this._downY = 0;\n',
               s, count=1)

# In mousedown handler, record downX/downY right after computing x/y
# Insert after `const y = ...`
s = re.sub(
    r'(const\s+y\s*=\s*e\.clientY\s*-\s*rect\.top;\s*)',
    r'\1\n\n      this._downX = x;\n      this._downY = y;\n',
    s,
    count=1
)

# Change beginDragMarker(hit) -> beginDragMarker(hit, x, y)
s = s.replace("this.beginDragMarker(hit);", "this.beginDragMarker(hit, x, y);")

# Update beginDragMarker signature if it exists
# Find: beginDragMarker(hit) { ... }
m = re.search(r'beginDragMarker\s*\(\s*hit\s*\)\s*\{', s)
if m:
    s = re.sub(r'beginDragMarker\s*\(\s*hit\s*\)\s*\{',
               r'beginDragMarker(hit, x, y) {',
               s, count=1)

    # Inside beginDragMarker, compute offsets using marker screen coords if present
    # Add near top of function body: (after opening brace)
    s = re.sub(
        r'(beginDragMarker\(hit, x, y\)\s*\{\s*)',
        r'\1'
        r'    // Preserve grab offset so the marker does not "jump" under the cursor\n'
        r'    const m = hit?.m || hit?.marker || hit;\n'
        r'    const sx = (m && typeof m._screenX === "number") ? m._screenX : this._downX;\n'
        r'    const sy = (m && typeof m._screenY === "number") ? m._screenY : this._downY;\n'
        r'    this.state.dragging.grabDX = (x ?? this._downX) - sx;\n'
        r'    this.state.dragging.grabDY = (y ?? this._downY) - sy;\n\n',
        s, count=1
    )
else:
    # If we can't find the function, we still can patch dragMarkerToXY to use grabDX/grabDY
    pass

# Patch dragMarkerToXY to subtract grab offset before mapping
# Add at start of function body:
# x = x - (this.state.dragging.grabDX||0)
# y = y - (this.state.dragging.grabDY||0)
s2 = s
m2 = re.search(r'dragMarkerToXY\s*\(\s*x\s*,\s*y\s*,\s*rectW\s*\)\s*\{', s2)
if m2:
    s2 = re.sub(
        r'(dragMarkerToXY\s*\(\s*x\s*,\s*y\s*,\s*rectW\s*\)\s*\{\s*)',
        r'\1'
        r'    const dx = this.state.dragging.grabDX || 0;\n'
        r'    const dy = this.state.dragging.grabDY || 0;\n'
        r'    x = x - dx;\n'
        r'    y = y - dy;\n\n',
        s2, count=1
    )
else:
    # Some revisions call it (x,y,width). Patch any variant: dragMarkerToXY(x, y, ...
    s2 = re.sub(
        r'(dragMarkerToXY\s*\(\s*x\s*,\s*y\s*,\s*[^)]*\)\s*\{\s*)',
        r'\1'
        r'    const dx = this.state.dragging.grabDX || 0;\n'
        r'    const dy = this.state.dragging.grabDY || 0;\n'
        r'    x = x - dx;\n'
        r'    y = y - dy;\n\n',
        s2, count=1
    )

s = s2
p.write_text(s, encoding="utf-8")
print("Patched InteractionEngine.js (grab offset + no jump).")
PY

echo "==> 2) Patching HUD to be compact by default (no scrollbar unless expanded)..."

python3 - <<'PY'
import pathlib, re
p = pathlib.Path("/home/turbogeek/vscode/charts/style.css")
css = p.read_text(encoding="utf-8")

# Replace the existing #legend block with compact/expandable behavior.
# We keep #hud.hidden functionality, but add #hud.collapsed / #hud.expanded.
css = re.sub(
    r'#legend\s*\{[^}]*\}',
    r'''#legend{
  padding:8px 12px;
  font-size:12px;
  line-height:1.35;
  color:var(--fg);
}

/* Compact HUD (default): single-line feel */
#hud.collapsed #legend{
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  max-height:32px;
}

/* Expanded HUD: scroll allowed */
#hud.expanded #legend{
  white-space:normal;
  overflow:auto;
  max-height:160px;
}''',
    css,
    count=1,
    flags=re.S
)

# Ensure canvas doesn't allow touch scrolling while interacting
if "touch-action" not in css:
    css += "\n\n#canvas{ touch-action: none; }\n"

p.write_text(css, encoding="utf-8")
print("Patched style.css (HUD collapsed/expanded + touch-action).")
PY

echo "==> 3) Patching main.js HUD button to toggle collapsed/expanded (instead of hiding)..."

python3 - <<'PY'
import pathlib, re
p = pathlib.Path("/home/turbogeek/vscode/charts/src/main.js")
s = p.read_text(encoding="utf-8")

# Ensure HUD starts collapsed
# Add after const hud = ... OR after DOM bindings if exists.
if "hud.classList.add(\"collapsed\")" not in s:
    s = re.sub(r'(const\s+hud\s*=.*?;\s*)', r'\1\nif (hud) hud.classList.add("collapsed");\n', s, count=1, flags=re.S)

# Replace existing hudToggle handler to toggle collapsed/expanded
# Look for an addEventListener/click referencing hud.classList.toggle("hidden") etc.
s = re.sub(
    r'(hudBtn.*?addEventListener\("click",\s*\(\)\s*=>\s*\{)(.*?)(\}\);)',
    r'''\1
    // Cycle HUD between compact and expanded (doesn't block interactions)
    if (!hud) return;
    if (hud.classList.contains("hidden")) {
      hud.classList.remove("hidden");
      hud.classList.add("collapsed");
      hud.classList.remove("expanded");
    } else if (hud.classList.contains("collapsed")) {
      hud.classList.remove("collapsed");
      hud.classList.add("expanded");
    } else {
      hud.classList.remove("expanded");
      hud.classList.add("collapsed");
    }
    // keep interaction mapping correct after height changes
    if (typeof queueResize === "function") queueResize();
\3''',
    s,
    count=1,
    flags=re.S
)

# If no hudBtn block found, add a simple one near the bottom
if "Cycle HUD between compact and expanded" not in s:
    # Add near end
    s += '\n\n// HUD toggle (added by patch)\n' \
         'const hudBtn2 = document.getElementById("hudToggle");\n' \
         'if (hudBtn2 && hud) {\n' \
         '  hudBtn2.addEventListener("click", () => {\n' \
         '    if (hud.classList.contains("hidden")) {\n' \
         '      hud.classList.remove("hidden");\n' \
         '      hud.classList.add("collapsed");\n' \
         '      hud.classList.remove("expanded");\n' \
         '    } else if (hud.classList.contains("collapsed")) {\n' \
         '      hud.classList.remove("collapsed");\n' \
         '      hud.classList.add("expanded");\n' \
         '    } else {\n' \
         '      hud.classList.remove("expanded");\n' \
         '      hud.classList.add("collapsed");\n' \
         '    }\n' \
         '    try { if (engine.resize) engine.resize(); else engine.render?.(); } catch {}\n' \
         '  });\n' \
         '}\n'

p.write_text(s, encoding="utf-8")
print("Patched main.js (HUD toggle collapsed/expanded).")
PY

echo
echo "==> Done."
echo "Restart server + hard refresh (Ctrl+Shift+R)."
