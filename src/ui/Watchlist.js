/**
 * Watchlist.js
 * Left sidebar: lists all symbols, shows a mini spark + last price.
 * Clicking a symbol calls engine.loadSymbol().
 */

const API = "http://172.16.1.92:8012";
const SPARK_W = 48, SPARK_H = 22;

export class Watchlist {
  /**
   * @param {HTMLElement} containerEl  The #watchlist div
   * @param {Engine}      engine
   */
  constructor(containerEl, engine) {
    this.el     = containerEl;
    this.engine = engine;
    this._items = [];
    this._interval = null;
    this._active = false;
  }

  async init() {
    this.el.innerHTML = `
      <div class="wl-header">
        <span class="wl-title">Watchlist</span>
        <button class="wl-close btn btn-icon" title="Close watchlist">✕</button>
      </div>
      <div class="wl-body" id="wl-body"></div>`;

    this.el.querySelector(".wl-close").onclick = () => this.hide();
    await this._load();
    this._active = true;
    this._interval = setInterval(() => this._refreshPrices(), 30_000);
  }

  async _load() {
    const body = this.el.querySelector("#wl-body");
    body.innerHTML = `<div class="wl-loading">Loading…</div>`;
    try {
      const res  = await fetch(`${API}/symbols`);
      const data = await res.json();
      const syms = Array.isArray(data) ? data : (data.symbols ?? []);
      this._items = syms.map(s => ({ symbol: s.symbol, name: s.name ?? s.symbol }));
      this._render();
      await this._refreshPrices();
    } catch (e) {
      body.innerHTML = `<div class="wl-loading">Offline</div>`;
    }
  }

  _render() {
    const body = this.el.querySelector("#wl-body");
    body.innerHTML = this._items.map(s => `
      <div class="wl-item" data-sym="${s.symbol}" title="${s.name}">
        <div class="wl-sym">${s.symbol}</div>
        <canvas class="wl-spark" id="wls-${s.symbol}" width="${SPARK_W}" height="${SPARK_H}"></canvas>
        <div class="wl-price" id="wlp-${s.symbol}">—</div>
        <div class="wl-chg"  id="wlc-${s.symbol}">—</div>
      </div>`).join("");

    body.querySelectorAll(".wl-item").forEach(el => {
      el.addEventListener("click", () => {
        const sym  = el.dataset.sym;
        const days = +( document.getElementById("daysSelect")?.value ?? 7);
        this.engine.loadSymbol?.(sym, days);
        // Highlight active
        body.querySelectorAll(".wl-item").forEach(i => i.classList.remove("active"));
        el.classList.add("active");
      });
    });
  }

  async _refreshPrices() {
    for (const item of this._items) {
      try {
        const res  = await fetch(`${API}/candles?symbol=${item.symbol}&limit=2&include_indicators=false`);
        const bars = await res.json();
        if (!Array.isArray(bars) || bars.length < 1) continue;

        const last  = bars[bars.length - 1];
        const prev  = bars.length > 1 ? bars[0] : last;
        const price = +last.close;
        const chg   = ((price - +prev.open) / +prev.open) * 100;

        const priceEl = document.getElementById(`wlp-${item.symbol}`);
        const chgEl   = document.getElementById(`wlc-${item.symbol}`);
        if (priceEl) priceEl.textContent = price.toLocaleString(undefined, { maximumFractionDigits: 2 });
        if (chgEl) {
          chgEl.textContent  = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
          chgEl.className    = "wl-chg " + (chg >= 0 ? "bull" : "bear");
        }

        // Spark: fetch 20 bars for mini line
        this._drawSpark(item.symbol, bars);
      } catch { /* ignore per-symbol errors */ }
    }
  }

  async _drawSpark(symbol, bars) {
    const canvas = document.getElementById(`wls-${symbol}`);
    if (!canvas) return;
    try {
      const res  = await fetch(`${API}/candles?symbol=${symbol}&limit=20&include_indicators=false`);
      const raw  = await res.json();
      if (!Array.isArray(raw) || raw.length < 2) return;
      raw.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const closes = raw.map(b => +b.close);
      const lo = Math.min(...closes), hi = Math.max(...closes);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, SPARK_W, SPARK_H);
      const last  = closes[closes.length - 1];
      const first = closes[0];
      const color = last >= first ? "#22c55e" : "#ef4444";
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      closes.forEach((v, i) => {
        const x = (i / (closes.length - 1)) * SPARK_W;
        const y = hi === lo ? SPARK_H / 2 : SPARK_H - ((v - lo) / (hi - lo)) * SPARK_H;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    } catch { /* ignore */ }
  }

  show() {
    this.el.classList.add("open");
    if (!this._active) this.init();
  }

  hide() {
    this.el.classList.remove("open");
  }

  toggle() {
    this.el.classList.contains("open") ? this.hide() : this.show();
  }

  destroy() {
    if (this._interval) clearInterval(this._interval);
  }
}
