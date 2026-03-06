/**
 * WebSocketStream — live tick stream with HTTP-polling fallback
 *
 * Tries `ws://<host>/ws?symbol=<sym>` first.
 * Falls back to 30-second HTTP polling via StreamController on failure.
 *
 * Emits:
 *   onTick({ t, price, open, high, low, close, volume, side })
 *   onTape({ t, price, side }) — for the live tape overlay
 */

const WS_HOST = "172.16.1.92:8012";
const TAPE_MAX = 30;

export class WebSocketStream {
  constructor() {
    this._ws        = null;
    this._symbol    = null;
    this._onTick    = null;
    this._onFail    = null;
    this._state     = null;
    this._pollTimer = null;
    this._usingPoll = false;
    this._lastClose = null;
    this._retryCount = 0;
    this._destroyed  = false;
  }

  /**
   * @param {string} symbol
   * @param {function} onTick  — called with each bar update
   * @param {function} onFail  — called if WS permanently unavailable (fallback started)
   * @param {object} state     — mutable state object (for liveTape)
   */
  connect(symbol, onTick, onFail, state) {
    this._symbol  = symbol;
    this._onTick  = onTick;
    this._onFail  = onFail;
    this._state   = state;
    this._destroyed = false;
    this._retryCount = 0;
    this._tryWS();
  }

  disconnect() {
    this._destroyed = true;
    this._clearPoll();
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
  }

  _tryWS() {
    if (this._destroyed) return;
    const url = `ws://${WS_HOST}/ws?symbol=${encodeURIComponent(this._symbol)}`;
    try {
      const ws = new WebSocket(url);
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this._retryCount = 0;
        this._usingPoll  = false;
        console.info("[WSStream] connected:", url);
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._handleTick(msg);
      };

      ws.onerror = () => {
        if (!opened) {
          this._retryCount++;
          if (this._retryCount >= 2) {
            console.warn("[WSStream] WS unavailable, falling back to polling");
            this._usingPoll = true;
            this._onFail?.();
            this._startPoll();
          } else {
            setTimeout(() => this._tryWS(), 2000);
          }
        }
      };

      ws.onclose = (ev) => {
        if (this._destroyed) return;
        if (this._usingPoll) return;
        console.warn("[WSStream] closed, retrying...", ev.code);
        setTimeout(() => this._tryWS(), 3000 * Math.min(this._retryCount + 1, 5));
      };

      this._ws = ws;
    } catch (e) {
      // WebSocket constructor itself threw (e.g. bad url)
      this._usingPoll = true;
      this._onFail?.();
      this._startPoll();
    }
  }

  _handleTick(msg) {
    // Normalise various tick shapes from the server
    const tick = {
      t:     msg.t ?? msg.time  ?? Date.now(),
      price: msg.c ?? msg.close ?? msg.price ?? 0,
      open:  msg.o ?? msg.open  ?? 0,
      high:  msg.h ?? msg.high  ?? 0,
      low:   msg.l ?? msg.low   ?? 0,
      close: msg.c ?? msg.close ?? msg.price ?? 0,
      volume:msg.v ?? msg.volume ?? 0,
      side:  msg.side ?? (msg.c >= (msg.o ?? msg.c) ? "buy" : "sell"),
    };

    this._appendTape(tick);
    this._onTick?.(tick);
  }

  _appendTape(tick) {
    if (!this._state) return;
    if (!Array.isArray(this._state.liveTape)) this._state.liveTape = [];
    this._state.liveTape.push({
      t:     tick.t,
      price: tick.price,
      side:  tick.side,
    });
    if (this._state.liveTape.length > TAPE_MAX) {
      this._state.liveTape.shift();
    }
  }

  // ── HTTP polling fallback ────────────────────────────────────────────────

  _startPoll() {
    if (this._pollTimer) return;
    this._doPoll();
    this._pollTimer = setInterval(() => this._doPoll(), 30_000);
  }

  _clearPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _doPoll() {
    if (this._destroyed) { this._clearPoll(); return; }
    try {
      const url = `http://${WS_HOST}/candles?symbol=${encodeURIComponent(this._symbol)}&limit=2`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const candles = data.candles ?? data ?? [];
      if (!candles.length) return;
      const last = candles[candles.length - 1];
      if (!last) return;
      const close = last.c ?? last.close ?? 0;
      if (close === this._lastClose) return;
      const prevClose = this._lastClose;
      this._lastClose = close;
      if (prevClose == null) return;   // skip first poll
      this._handleTick({
        t:    last.t ?? last.time ?? Date.now(),
        o:    last.o ?? last.open  ?? prevClose,
        h:    last.h ?? last.high  ?? close,
        l:    last.l ?? last.low   ?? close,
        c:    close,
        v:    last.v ?? last.volume ?? 0,
        side: close >= prevClose ? "buy" : "sell",
      });
    } catch (e) {
      // network error — silently swallow
    }
  }
}
