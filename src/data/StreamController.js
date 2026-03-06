/**
 * StreamController — polls the live API every N seconds,
 * appends/updates bars on state, then fires onUpdate so the engine re-renders.
 *
 * Usage:
 *   const sc = new StreamController(state, () => engine.render(), s => engine.setStatus(s));
 *   sc.start("BTC", 30_000);
 *   sc.stop();
 */

const API = "http://172.16.1.92:8012";

export class StreamController {
  constructor(state, onUpdate, onStatus) {
    this.state    = state;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this._timer   = null;
    this._active  = false;
    this._symbol  = null;
  }

  get active() { return this._active; }

  start(symbol, intervalMs = 30_000) {
    this.stop();
    this._active   = true;
    this._symbol   = symbol;
    this._errorCount = 0;

    // Attempt to trigger a fresh fetch from exchange before starting
    fetch(`${API}/candles/fetch`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ symbol, timeframe: "1m", limit: 5, fetch_latest: true }),
    }).catch(() => {}); // non-blocking, best-effort

    this._poll();
    this._timer = setInterval(() => this._poll(), intervalMs);
    this.onStatus?.(`⬤ Live · ${symbol}`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._active = false;
  }

  async _poll() {
    if (!this._active) return;
    try {
      const res = await fetch(
        `${API}/candles?symbol=${encodeURIComponent(this._symbol)}&limit=10&include_indicators=false`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw) || !raw.length) return;

      // API returns newest-first; sort ascending
      raw.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const bars   = this.state.bars;
      const volume = this.state.volume;
      if (!bars.length) return;

      let changed = false;

      for (const c of raw) {
        const t    = new Date(c.timestamp).getTime();
        const last = bars[bars.length - 1];

        if (t > last.t) {
          // Entirely new bar
          bars.push({ t, o: +c.open, h: +c.high, l: +c.low, c: +c.close });
          volume.push({ t, v: +c.volume });
          changed = true;
        } else if (t === last.t) {
          // Update in-progress bar
          if (+c.high  > last.h) { last.h = +c.high;  changed = true; }
          if (+c.low   < last.l) { last.l = +c.low;   changed = true; }
          if (+c.close !== last.c) { last.c = +c.close; changed = true; }
          if (volume.length) {
            const vLast = volume[volume.length - 1];
            if (vLast.t === t) { vLast.v = +c.volume; }
          }
        }
      }

      if (changed) {
        this._errorCount = 0;
        this.onUpdate?.();
      }
    } catch (err) {
      this._errorCount = (this._errorCount ?? 0) + 1;
      if (this._errorCount <= 3) {
        console.warn("StreamController poll:", err.message);
      }
    }
  }
}
