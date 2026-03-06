# MarketMind Charts Engine – Claude Working Guide

## Goal
This repo is a reusable **charting engine** (not a one-off MarketMind UI).  
Do not “restart” or replace the architecture. Extend it.

Core requirements:
- Multi-pane timeline charts (price + MACD + decision lane)
- Draggable annotations (buy/sell markers) without drift/jump
- Pan/zoom with consistent mapping
- Works in plain HTML/JS without React/Vue/etc
- Mobile friendly (pointer events + touch)

---

## Current Architecture (Do Not Break)
Data flow:
1) **DataEngine** loads bars / indicators / events into `state`
2) **LayoutEngine** computes a `scene` (panes + visible windowed data)
3) **Renderer** draws layers using `scene`
4) **InteractionEngine** updates `state` based on pointer input and calls render

Files:
- `src/core/Engine.js` wires everything up
- `src/layout/LayoutEngine.js` computes `scene`
- `src/render/Renderer.js` draws layers and stores `state._scene`
- `src/render/layers/*` are independent render layers
- `src/interaction/InteractionEngine.js` handles pointer input and modifies `state`

**Never** remove panes/layers or collapse into one file.  
**Never** introduce a new framework.

---

## Non-negotiable Rule: One Geometry Source of Truth
Rendering and interaction must use the **same pane geometry**.

- Timeline mapping must be `pane.x/pane.w` based (NOT full canvas width)
- Interaction must invert the exact same mapping the renderer uses
- Renderer must persist the last computed scene into `state._scene`

If you change pane layout, you must update interaction mapping accordingly.

---

## How Marker Dragging Must Work
Markers are drawn by layers and each marker may be given:
- `m._screenX`, `m._screenY`, `m._screenPane` (set during render)

Dragging must:
- Preserve grab offset (no jump)
- Update `m.t` using the pane’s x mapping:
  - `u = clamp((x - pane.x)/pane.w, 0..1)`
  - `m.t = t0 + u*(t1-t0)`

If marker is in price pane and supports `m.price`, it may update price from y.

---

## Interaction Standard (Pro Feel)
Interaction uses:
- Pointer Events (`pointerdown/move/up`) and `setPointerCapture`
- `touch-action: none` on canvas
- Pan: drag empty space horizontally
- Zoom: wheel zoom anchored at cursor within price pane
- Click: selects marker/position only when it wasn’t a drag

Do not revert to mouse events only.

---

## “Pro” UI Guidelines (Don’t reset layout)
- Toolbar + docked HUD above chart is fine
- HUD must not block marker dragging (keep HUD outside canvas)
- Mobile sizing: chart must fit in a constrained container, not forced full-screen

---

## What to Build Next (Preferred Order)
1) **Axis Labels** (TradingView style):
   - right price scale with label bubble at crosshair
   - bottom time scale with tick labels
2) **Crosshair “info strip”**:
   - OHLC, % change, volume, MACD at cursor
3) **Better marker UX**:
   - snap-to-candle option
   - keyboard nudge (left/right)
4) **Export labels**:
   - export annotations in a stable JSON schema
5) **Plugin system** (optional):
   - keep MarketMind-specific layers under a `plugins/` folder

---

## What Not To Do
- Do not add React/Vue/Svelte.
- Do not rewrite the engine around Chart.js.
- Do not create a “new architecture” that replaces Layout/Renderer/Interaction.
- Do not change imports/paths without updating the entire dependency tree.
- Do not “simplify” by deleting layers; refactor only if behavior is identical.

---

## Testing Checklist (Before any PR)
- Drag marker at far left and far right: stays under cursor (no drift)
- Drag marker starts exactly at grab point (no jump)
- Pan left/right and zoom in/out: stable
- Touch drag works on mobile (pointer events)
- No console errors
