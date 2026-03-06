/**
 * MTFPanel — Multi-Timeframe Confluence Panel (DOM overlay)
 *
 * For each TF computes RSI direction, MACD histogram sign, EMA trend
 * from `state.rawBars` (full 1-minute history) and displays a compact
 * table in the top-right corner of #chart-wrapper.
 */

const TFS = [
  { label: "1m",   mins: 1   },
  { label: "5m",   mins: 5   },
  { label: "15m",  mins: 15  },
  { label: "1h",   mins: 60  },
  { label: "4h",   mins: 240 },
  { label: "1D",   mins: 1440 },
];

/** Resample 1m bars into higher timeframe bars */
function resample(bars1m, mins) {
  if (mins <= 1) return bars1m;
  const ms   = mins * 60_000;
  const out  = [];
  let grp    = null;
  for (const b of bars1m) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!grp || grp.t !== bucket) {
      if (grp) out.push(grp);
      grp = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      if (b.h > grp.h) grp.h = b.h;
      if (b.l < grp.l) grp.l = b.l;
      grp.c = b.c;
    }
  }
  if (grp) out.push(grp);
  return out;
}

/** Simple RSI-14 on close array */
function rsi14(bars) {
  if (bars.length < 15) return null;
  const closes = bars.map(b => b.c);
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += (-d);
  }
  let ag = gains / 14, al = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * 13 + Math.max(0, d)) / 14;
    al = (al * 13 + Math.max(0, -d)) / 14;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** EMA */
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Quick MACD histogram sign from last value */
function macdSign(bars) {
  if (bars.length < 27) return 0;
  const closes = bars.map(b => b.c);
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  if (fast == null || slow == null) return 0;
  const line = fast - slow;
  // signal = 9-period EMA of MACD line (simplified: use last value sign)
  return line > 0 ? 1 : line < 0 ? -1 : 0;
}

/** EMA alignment: 9-period EMA > 21-period EMA → bullish */
function emaAlign(bars) {
  if (bars.length < 22) return 0;
  const closes = bars.map(b => b.c);
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (e9 == null || e21 == null) return 0;
  return e9 > e21 ? 1 : -1;
}

/**
 * Compute confluence score for one timeframe.
 * Returns { rsi, macd, ema, score }
 * score: -3..+3  (each component: +1 bull, -1 bear, 0 neutral)
 */
function computeTF(bars1m, mins) {
  const rs  = resample(bars1m, mins);
  if (!rs.length) return null;
  const r   = rsi14(rs);
  const rsiDir = r == null ? 0 : r > 55 ? 1 : r < 45 ? -1 : 0;
  const mc  = macdSign(rs);
  const ea  = emaAlign(rs);
  return {
    rsi:   r != null ? r.toFixed(1) : "—",
    rsiDir,
    macd:  mc,
    ema:   ea,
    score: rsiDir + mc + ea,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export class MTFPanel {
  constructor(container) {
    this._el = null;
    this._container = container;   // #chart-wrapper
    this._visible = false;
  }

  _build() {
    const el = document.createElement("div");
    el.id = "mtf-panel";
    el.className = "mtf-panel";
    el.innerHTML = `
      <div class="mtf-header">
        <span>MTF Confluence</span>
        <button class="mtf-close" title="Close">✕</button>
      </div>
      <table class="mtf-table">
        <thead>
          <tr>
            <th>TF</th>
            <th>RSI</th>
            <th>MACD</th>
            <th>EMA</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody id="mtf-body"></tbody>
      </table>`;
    el.querySelector(".mtf-close").addEventListener("click", () => this.hide());
    this._container.appendChild(el);
    this._el = el;
  }

  show() {
    if (!this._el) this._build();
    this._el.style.display = "block";
    this._visible = true;
  }

  hide() {
    if (this._el) this._el.style.display = "none";
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }

  refresh(rawBars) {
    if (!this._el || !this._visible) return;
    const tbody = this._el.querySelector("#mtf-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const tf of TFS) {
      const r = computeTF(rawBars, tf.mins);
      if (!r) {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${tf.label}</td><td colspan="4" style="opacity:.4">not enough data</td>`;
        tbody.appendChild(row);
        continue;
      }
      const scoreColor = r.score >= 2 ? "#22c55e" : r.score <= -2 ? "#ef4444" : r.score > 0 ? "#86efac" : r.score < 0 ? "#fca5a5" : "#94a3b8";
      const arrow = v => v === 1 ? "▲" : v === -1 ? "▼" : "—";
      const col   = v => v === 1 ? "#22c55e" : v === -1 ? "#ef4444" : "#94a3b8";
      const row = document.createElement("tr");
      row.innerHTML = `
        <td class="mtf-tf">${tf.label}</td>
        <td style="color:${col(r.rsiDir)}">${r.rsi}</td>
        <td style="color:${col(r.macd)}">${arrow(r.macd)}</td>
        <td style="color:${col(r.ema)}">${arrow(r.ema)}</td>
        <td style="color:${scoreColor};font-weight:bold">${r.score > 0 ? "+" : ""}${r.score}</td>`;
      tbody.appendChild(row);
    }
  }
}
