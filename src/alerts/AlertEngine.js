/**
 * AlertEngine.js
 * Evaluate price/RSI/EMA conditions on every streaming poll.
 * Alerts are stored in state.alerts[] and persisted to localStorage.
 *
 * Alert shape:
 *   { id, symbol, type, value, triggered, createdAt, label? }
 *   type: "price_above" | "price_below" | "rsi_above" | "rsi_below" | "ema_cross_bull" | "ema_cross_bear"
 */

const LS_KEY = "mm_alerts";

export class AlertEngine {
  constructor(state, onTrigger) {
    this.state     = state;
    this.onTrigger = onTrigger; // (alert) => void
    this._load();
  }

  // ── Persistence ───────────────────────────────────────────
  _load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
      this.state.alerts = Array.isArray(saved) ? saved : [];
    } catch {
      this.state.alerts = [];
    }
  }

  _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state.alerts)); } catch {}
  }

  add(alert) {
    const id = Date.now();
    this.state.alerts.push({ id, triggered: false, createdAt: Date.now(), ...alert });
    this._save();
    return id;
  }

  remove(id) {
    this.state.alerts = this.state.alerts.filter(a => a.id !== id);
    this._save();
  }

  clear() {
    this.state.alerts = [];
    this._save();
  }

  // ── Evaluation (call on every stream tick) ────────────────
  evaluate() {
    const bars  = this.state.bars;
    const rsi   = this.state.rsi   ?? [];
    const ema9  = this.state.ema9  ?? [];
    const ema21 = this.state.ema21 ?? [];
    if (!bars.length) return;

    const lastBar  = bars[bars.length - 1];
    const lastRsi  = [...rsi ].reverse().find(v => v != null) ?? null;
    const lastE9   = [...ema9 ].reverse().find(v => v != null) ?? null;
    const lastE21  = [...ema21].reverse().find(v => v != null) ?? null;
    const prevE9   = ema9[ema9.length - 2]   ?? null;
    const prevE21  = ema21[ema21.length - 2] ?? null;

    let changed = false;
    for (const a of this.state.alerts) {
      if (a.triggered)  continue;
      if (a.symbol && a.symbol !== this.state.symbol) continue;

      let fire = false;
      switch (a.type) {
        case "price_above":   fire = lastBar.c  >= a.value; break;
        case "price_below":   fire = lastBar.c  <= a.value; break;
        case "rsi_above":     fire = lastRsi != null && lastRsi >= a.value; break;
        case "rsi_below":     fire = lastRsi != null && lastRsi <= a.value; break;
        case "ema_cross_bull":
          fire = prevE9 != null && prevE21 != null && lastE9 != null && lastE21 != null
               && prevE9 <= prevE21 && lastE9 > lastE21;
          break;
        case "ema_cross_bear":
          fire = prevE9 != null && prevE21 != null && lastE9 != null && lastE21 != null
               && prevE9 >= prevE21 && lastE9 < lastE21;
          break;
      }

      if (fire) {
        a.triggered    = true;
        a.triggeredAt  = Date.now();
        a.triggeredVal = lastBar.c;
        changed = true;
        this._notify(a, lastBar);
        this.onTrigger?.(a);
      }
    }

    if (changed) this._save();
  }

  _notify(a, bar) {
    const label = a.label || `${a.type.replace(/_/g, " ")} ${a.value ?? ""}`;
    const body  = `${a.symbol ?? this.state.symbol} · ${bar.c.toFixed(2)}`;

    // Browser notification (requires permission)
    if ("Notification" in window) {
      const perm = Notification.permission;
      if (perm === "granted") {
        new Notification(`🔔 Alert: ${label}`, { body, icon: "/favicon.ico" });
      } else if (perm !== "denied") {
        Notification.requestPermission().then(p => {
          if (p === "granted") new Notification(`🔔 Alert: ${label}`, { body });
        });
      }
    }
  }

  // ── UI helpers ────────────────────────────────────────────
  /** Returns the current alert list for rendering. */
  list() { return this.state.alerts; }
}
