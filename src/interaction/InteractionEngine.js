import { clamp } from "../util/math.js";

export class InteractionEngine {
  constructor(canvas, state, undo, onRender, setStatus) {
    this.canvas = canvas;
    this.state = state;
    this.undo = undo;
    this.onRender = onRender;
    this.setStatus = setStatus || function(){};

    this.isPanning = false;
    this.panLastX = 0;

    this._requestOlder = null;
    this._activePointerId = null;
    this._movedSinceDown = false;

    this.HIT_R = 12;
  }

  setLeftLoadHook(fn) {
    this._requestOlder = fn;
  }

  // ---------- Domain clamping ----------
  // Hard stop: the view can never scroll so far that all data is off-screen.
  // Allows a 20% margin past each edge so the first/last bar can sit
  // comfortably near the centre, but no further.
  _clampDomain() {
    var bars = this.state.bars;
    if (!bars || bars.length < 2) return;

    var domain = this.state.xDomain;
    var t0 = domain[0];
    var t1 = domain[1];
    var span = t1 - t0;
    if (!(span > 0)) return;

    var margin     = span * 0.20;
    var dataStart  = bars[0].t;
    var dataEnd    = bars[bars.length - 1].t;

    // Panned too far right (into the past) — t1 would go before data starts
    if (t1 < dataStart - margin) {
      t1 = dataStart - margin;
      t0 = t1 - span;
      this.state.xDomain = [t0, t1];
      return;
    }
    // Panned too far left (into the future) — t0 would go after data ends
    if (t0 > dataEnd + margin) {
      t0 = dataEnd + margin;
      t1 = t0 + span;
      this.state.xDomain = [t0, t1];
    }
  }

  // ---------- Geometry ----------
  // The lane pane has a fixed left gutter (labels column); the actual
  // plotting area starts GUTTER px in.  Interaction mapping must use the
  // same origin/width that the renderer uses.
  static get LANE_GUTTER() { return 78; }

  _scene() {
    return this.state._scene || null;
  }

  _pane(key) {
    var scene = this._scene();
    if (!scene || !scene.panes) return null;
    return scene.panes[key] || null;
  }

  // Returns the effective plotting rectangle for a marker's pane.
  // All panes now use the same full-width tToX formula (no gutter offset),
  // so we simply return the pane as-is regardless of key.
  _paneForMarker(m) {
    var key = (m && (m._screenPane || m.pane)) || "price";
    var pane = this._pane(key);
    if (!pane) pane = this._pane("price");
    return pane || null;
  }

  _pointerXY(e, cachedRect) {
    var rect = cachedRect || this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      rect: rect
    };
  }

  _xToT(x, paneKey) {
    if (!paneKey) paneKey = "price";
    var scene = this._scene();
    if (!scene) return null;

    var pane = this._pane(paneKey);
    if (!pane) return null;

    var t0 = scene.xDomain[0];
    var t1 = scene.xDomain[1];
    var span = t1 - t0;
    if (!(span > 0)) return null;

    var u = (x - pane.x) / pane.w;
    u = clamp(u, 0, 1);
    return t0 + u * span;
  }

  _yToPrice(y) {
    var ps = this.state._priceScale;
    // CandlesLayer sets pixToY; also handle legacy yToPrice / inv aliases.
    if (ps && typeof ps.pixToY   === "function") return ps.pixToY(y);
    if (ps && typeof ps.yToPrice === "function") return ps.yToPrice(y);
    if (ps && typeof ps.inv      === "function") return ps.inv(y);

    var scene = this._scene();
    var pane = this._pane("price");
    if (!scene || !pane || !scene.bars || !scene.bars.length) return null;

    var lo = Infinity, hi = -Infinity;
    for (var i=0;i<scene.bars.length;i++){
      var b = scene.bars[i];
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    if (!(hi > lo)) return null;

    var u = (y - pane.y) / pane.h;
    u = clamp(u, 0, 1);

    return hi - u * (hi - lo);
  }

  // ---------- Hit testing ----------
  hitMarker(x,y){
    for (var i=0;i<this.state.markers.length;i++){
      var m = this.state.markers[i];
      if (m._screenX == null || m._screenY == null) continue;
      var dx = x - m._screenX;
      var dy = y - m._screenY;
      if (dx*dx + dy*dy <= this.HIT_R*this.HIT_R) return m;
    }
    return null;
  }

  hitPositionHandle(x,y){
    for (var i=0;i<this.state.positions.length;i++){
      var p = this.state.positions[i];
      if (!p._handles) continue;
      var keys = ["stop","tp"];
      for (var k=0;k<keys.length;k++){
        var h = p._handles[keys[k]];
        if (!h) continue;
        var r = h.r || 9;
        var dx = x - h.x;
        var dy = y - h.y;
        if (dx*dx + dy*dy <= r*r) {
          return { pos:p, key:keys[k] };
        }
      }
    }
    return null;
  }

  beginDragMarker(marker, x, y){
    // Recompute screen position live from scene geometry so grabDX is
    // always consistent with how dragMarkerToXY maps coords back.
    var scene = this._scene();
    var pane  = this._paneForMarker(marker);
    var sx = x;  // fallback: no jump
    var sy = y;
    if (scene && pane) {
      var _t0  = this.state.xDomain[0];
      var _t1  = this.state.xDomain[1];
      var _span = _t1 - _t0;
      if (_span > 0) {
        sx = pane.x + ((marker.t - _t0) / _span) * pane.w;
      }
      if (typeof marker.price === "number") {
        var ps = this.state._priceScale;
        if (ps && typeof ps.yToPix === "function") sy = ps.yToPix(marker.price);
      }
    }

    this.state.dragging = {
      active:  true,
      type:    "marker",
      marker:  marker,
      grabDX:  x - sx,
      grabDY:  y - sy
    };

    this.setStatus("Dragging " + marker.kind + " (" + marker.pane + ")…");
  }

  beginDragPositionHandle(obj){
    var pos = obj.pos;
    var key = obj.key;

    this.state.selectedPositionId = pos.id;
    this.state.dragging = {
      active:true,
      type:key,
      id:pos.id
    };
    this.setStatus("Dragging " + key.toUpperCase() + "…");
  }

  dragMarkerToXY(x, y){
    var d = this.state.dragging;
    if (!d || !d.marker) return;

    var m = d.marker;
    var pane = this._paneForMarker(m);
    if (!pane) return;

    // Always read xDomain from state directly — avoids stale scene reference
    // when state.xDomain was reassigned (array replacement) since last render.
    var t0   = this.state.xDomain[0];
    var t1   = this.state.xDomain[1];
    var span = t1 - t0;
    if (!(span > 0)) return;

    var xAdj = x - (d.grabDX || 0);
    var u = (xAdj - pane.x) / pane.w;
    u = clamp(u, 0, 1);
    m.t = t0 + u * span;

    if (m.pane === "price" && typeof m.price === "number") {
      var p = this._yToPrice(y - (d.grabDY || 0));
      if (p != null) m.price = p;
    }
  }

  dragPositionHandleToY(y){
    var d = this.state.dragging;
    if (!d || !d.id) return;

    var pos = null;
    for (var i=0;i<this.state.positions.length;i++){
      if (this.state.positions[i].id === d.id){
        pos = this.state.positions[i];
        break;
      }
    }
    if (!pos) return;

    var p = this._yToPrice(y);
    if (p == null) return;

    if (d.type === "stop") pos.stop = p;
    if (d.type === "tp") pos.tp = p;
  }

  endDrag(){
    this.state.dragging = { active:false };
    this.setStatus("");
  }

  attach(){
    var c = this.canvas;
    c.style.touchAction = "none";

    var self = this;

    // ---------- Context menu ----------
    this._ctxMenu = null;

    function showContextMenu(e) {
      e.preventDefault();
      hideContextMenu();

      var pos  = self._pointerXY(e);
      var x    = pos.x,  y = pos.y;
      var hit  = self.hitMarker(x, y);

      var menu = document.createElement("div");
      menu.className = "ctx-menu";

      var items = [];
      if (hit) {
        items.push({ label: "Delete marker", fn: () => {
          self.state.markers = self.state.markers.filter(m => m !== hit);
          self.state.selectedMarkerId = null;
          self.onRender();
        }});
        items.push({ label: hit.kind === "buy" ? "Change to Sell" : "Change to Buy", fn: () => {
          hit.kind = hit.kind === "buy" ? "sell" : "buy";
          self.onRender();
        }});
      } else {
        var t = self._xToT(x, "price");
        var price = self._yToPrice(y);
        var pane  = self._whichPane(y);
        items.push({ label: "Add Buy signal", fn: () => {
          self.state.markers.push({ id: Date.now(), t, price, kind:"buy", pane: pane || "price", source:"user" });
          self.onRender();
        }});
        items.push({ label: "Add Sell signal", fn: () => {
          self.state.markers.push({ id: Date.now()+1, t, price, kind:"sell", pane: pane || "price", source:"user" });
          self.onRender();
        }});
        items.push({ label: null, fn: null });  // separator
        items.push({ label: "Auto High/Low signals", fn: () => {
          if (self._engine) self._engine.autoPlaceSignals();
          else self.setStatus("Auto-signals: engine ref not set");
        }});
        items.push({ label: "Clear all signals", fn: () => {
          if (self._engine && confirm("Remove all placed signals?")) self._engine.clearSignals();
        }, danger: true });
      }

      items.forEach(function(item) {
        if (item.label === null) {
          // visual separator
          var sep = document.createElement("div");
          sep.className = "ctx-sep";
          menu.appendChild(sep);
          return;
        }
        var btn = document.createElement("button");
        btn.className = "ctx-item" + (item.danger ? " ctx-item-danger" : "");
        btn.textContent = item.label;
        // Use mousedown so the action fires BEFORE the browser can blur/remove
        // the element. stopPropagation prevents the outside-dismiss listener
        // from also triggering on this same event.
        btn.onmousedown = function(ev) {
          ev.stopPropagation();
          item.fn();
          hideContextMenu();
        };
        menu.appendChild(btn);
      });

      // Position menu near cursor, keeping inside viewport
      menu.style.left = "0";
      menu.style.top  = "0";
      document.body.appendChild(menu);
      var mw = menu.offsetWidth  || 160;
      var mh = menu.offsetHeight || items.length * 32;
      menu.style.left = Math.min(e.clientX, window.innerWidth  - mw - 4) + "px";
      menu.style.top  = Math.min(e.clientY, window.innerHeight - mh - 4) + "px";

      self._ctxMenu = menu;

      // Dismiss when user clicks anywhere OUTSIDE the menu.
      // Using mousedown + containment check so items' mousedown can
      // stopPropagation() and prevent premature dismissal.
      function outsideDismiss(ev) {
        if (self._ctxMenu && !self._ctxMenu.contains(ev.target)) {
          hideContextMenu();
          document.removeEventListener("mousedown", outsideDismiss);
        }
      }
      // Defer one tick so the current contextmenu/mousedown doesn't instantly dismiss
      setTimeout(function() {
        document.addEventListener("mousedown", outsideDismiss);
      }, 0);
    }

    function hideContextMenu() {
      if (self._ctxMenu) {
        self._ctxMenu.remove();
        self._ctxMenu = null;
      }
    }

    // Returns which pane key a canvas-space y coordinate falls in.
    self._whichPane = function(y) {
      var scene = self._scene();
      if (!scene) return "price";
      var panes = scene.panes;
      for (var k in panes) {
        var p = panes[k];
        if (y >= p.y && y < p.y + p.h) return k;
      }
      return "price";
    };

    c.addEventListener("contextmenu", showContextMenu);

    // ---------- Keyboard (Delete selected marker + drawing/signal shortcuts) ----------
    document.addEventListener("keydown", function(e) {
      var tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        // Delete selected drawing
        if (self.state.selectedDrawingId != null) {
          self.state.drawings = self.state.drawings.filter(d => d.id !== self.state.selectedDrawingId);
          self.state.selectedDrawingId = null;
          self.onRender();
          return;
        }
        var selId = self.state.selectedMarkerId;
        if (selId != null) {
          self.state.markers = self.state.markers.filter(m => m.id !== selId);
          self.state.selectedMarkerId = null;
          self.onRender();
        }
      }
      if (e.key === "Escape") {
        hideContextMenu();
        // Cancel any in-progress drawing
        if (self.state.drawingMode) {
          self.state.drawingMode = null;
          self.state._drawingInProgress = null;
          self.canvas.style.cursor = "default";
        }
        self.state.selectedMarkerId = null;
        self.state.selectedDrawingId = null;
        self.onRender();
      }
      // B/S = place buy/sell signal at cursor
      if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey) {
        if (self._engine) self._engine.placeSignalAtCursor("buy");
      }
      if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
        if (self._engine) self._engine.placeSignalAtCursor("sell");
      }
      // H = hline drawing mode, T = trendline drawing mode
      if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey) {
        if (self._engine) self._engine.setDrawingMode("hline");
      }
      if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey) {
        if (self._engine) self._engine.setDrawingMode("trendline");
      }
    });

    function onDown(e){
      if (e.pointerType === "mouse" && e.button !== 0) return;

      // Cache rect once at pointer-down and reuse for the entire drag/pan.
      self._dragRect = self.canvas.getBoundingClientRect();

      var pos = self._pointerXY(e, self._dragRect);
      var x = pos.x;
      var y = pos.y;

      self._activePointerId = e.pointerId;
      self._movedSinceDown = false;

      try{ c.setPointerCapture(e.pointerId); }catch(err){}

      // ── Drawing mode ─────────────────────────────────────────────────────
      var mode = self.state.drawingMode;
      if (mode) {
        var t = self._xToT(x, "price");
        var price = self._yToPrice(y);
        if (t != null && price != null) {
          if (mode === "hline") {
            self.state.drawings.push({ id: "d_" + Date.now(), type: "hline", price: price });
            self.state.drawingMode = null;
            self.canvas.style.cursor = "default";
            self.setStatus("Hline placed at " + price.toFixed(4));
            self.onRender();
            return;
          }
          if (mode === "trendline") {
            var wip = self.state._drawingInProgress;
            if (!wip) {
              // First click: record start point
              self.state._drawingInProgress = { t1: t, p1: price };
              self.setStatus("Trendline: click end point…");
            } else {
              // Second click: finalise
              self.state.drawings.push({
                id: "d_" + Date.now(),
                type: "trendline",
                t1: wip.t1, p1: wip.p1,
                t2: t,      p2: price
              });
              self.state._drawingInProgress = null;
              self.state.drawingMode = null;
              self.canvas.style.cursor = "default";
              self.setStatus("Trendline placed");
              self.onRender();
            }
            return;
          }
        }
        return;  // absorb click in drawing mode even if coords failed
      }
      // ─────────────────────────────────────────────────────────────────────

      var ph = self.hitPositionHandle(x,y);
      if (ph){
        self.beginDragPositionHandle(ph);
        self.onRender();
        return;
      }

      var hit = self.hitMarker(x,y);
      if (hit){
        self.state.selectedMarkerId = hit.id;  // click-select
        self.beginDragMarker(hit,x,y);
        self.onRender();
        return;
      }

      self.isPanning = true;
      self.panLastX = x;
    }

    function onMove(e){
      if (self._activePointerId != null && e.pointerId !== self._activePointerId) return;

      var activeRect = self._dragRect || null;
      var pos = self._pointerXY(e, activeRect);
      var x = pos.x;
      var y = pos.y;
      var rect = pos.rect;

      var scene = self._scene();
      if (scene){
        var t = self._xToT(x,"price");
        if (t != null) {
          self.state.cursorT = t;
          self.state.crosshairT = t;  // alias used by placeSignalAtCursor
        }
        // Also track raw Y so CrosshairLayer can draw the horizontal hair + price bubble
        self.state.cursorY = y;

        // Trendline live preview
        if (self.state.drawingMode === "trendline" && self.state._drawingInProgress) {
          self.state._drawingInProgress._previewT = t;
          self.state._drawingInProgress._previewP = self._yToPrice(y);
        }
      }

      if (self.state.dragging && self.state.dragging.active){
        self._movedSinceDown = true;

        if (self.state.dragging.type === "marker"){
          self.dragMarkerToXY(x,y);
          self.onRender();
          return;
        }

        if (self.state.dragging.type === "stop" || self.state.dragging.type === "tp"){
          self.dragPositionHandleToY(y);
          self.onRender();
          return;
        }
      }

      if (self.isPanning && scene){
        self._movedSinceDown = true;

        var t0 = self.state.xDomain[0];
        var t1 = self.state.xDomain[1];
        var span = t1 - t0;

        var dx = x - self.panLastX;

        var pane = self._pane("price");
        var denom = pane ? pane.w : rect.width;

        var dt = -(dx / denom) * span;

        t0 += dt;
        t1 += dt;

        self.state.xDomain = [t0,t1];
        self.panLastX = x;
        self._clampDomain();
        self.onRender();
        return;
      }

      // Hover only: crosshair + HUD need a fresh frame on every mouse move.
      // Throttle to one RAF so we never queue more than one pending render.
      if (!self._hoverRafPending) {
        self._hoverRafPending = true;
        requestAnimationFrame(function() {
          self._hoverRafPending = false;
          self.onRender();
        });
      }
    }

    function onUp(e){
      if (self._activePointerId != null && e.pointerId !== self._activePointerId) return;

      try{ c.releasePointerCapture(e.pointerId); }catch(err){}

      if (self.state.dragging && self.state.dragging.active){
        self.endDrag();
      }

      self.isPanning = false;
      self._activePointerId = null;
      self._dragRect = null;  // release cached rect
      self.onRender();
    }

    c.addEventListener("pointerdown",onDown);
    c.addEventListener("pointermove",onMove);
    c.addEventListener("pointerup",onUp);
    c.addEventListener("pointercancel",onUp);

    c.addEventListener("wheel",function(e){
      e.preventDefault();

      var pos  = self._pointerXY(e);
      var x    = pos.x;
      var rect = pos.rect;

      var t0   = self.state.xDomain[0];
      var t1   = self.state.xDomain[1];
      var span = t1 - t0;

      // Normalise deltaY across deltaMode variants and device types.
      // deltaMode 0 = CSS pixels, 1 = lines (~32px each), 2 = pages.
      var rawDelta = e.deltaY;
      if (e.deltaMode === 1) rawDelta *= 32;
      if (e.deltaMode === 2) rawDelta *= 400;

      // Speed: 0.0025 per normalised pixel  →  standard mouse wheel notch
      // ≈120 px equivalent  →  factor ≈ 1.35 (35% zoom per notch).
      // Trackpad 3-px events → 0.75% each, accumulating smoothly.
      var factor = Math.exp(0.0025 * rawDelta);
      var newSpan = clamp(
        span * factor,
        self.state.limits.minSpanMs,
        self.state.limits.maxSpanMs
      );

      // Anchor zoom at cursor position within price pane
      var pane  = self._pane("price");
      var x0    = pane ? pane.x    : 0;
      var denom = pane ? pane.w    : rect.width;
      var u     = clamp((x - x0) / denom, 0, 1);
      var anchor = t0 + u * span;

      t0 = anchor - u * newSpan;
      t1 = t0 + newSpan;

      self.state.xDomain = [t0, t1];
      self._clampDomain();
      self.onRender();
    },{passive:false});
  }
}