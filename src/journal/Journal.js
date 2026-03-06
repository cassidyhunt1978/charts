/**
 * Journal.js
 * Named trade sets with notes, persisted to localStorage.
 *
 * Each entry: { id, name, symbol, createdAt, note, markers: [...] }
 */

const LS_KEY = "mm_journal";

export class Journal {
  constructor(state) {
    this.state = state;
    this._entries = this._load();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
  }

  _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this._entries)); } catch {}
  }

  /** Save current markers as a named entry. */
  save(name, note = "") {
    const entry = {
      id:        Date.now(),
      name,
      note,
      symbol:    this.state.symbol,
      timeframe: this.state.timeframe,
      createdAt: Date.now(),
      markers:   JSON.parse(JSON.stringify(this.state.markers)),
    };
    this._entries.unshift(entry);
    this._save();
    return entry.id;
  }

  /** Restore markers from a saved entry. */
  restore(id) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return false;
    this.state.markers = JSON.parse(JSON.stringify(entry.markers));
    this.state.selectedMarkerId = null;
    return true;
  }

  /** Update the note on an existing entry. */
  setNote(id, note) {
    const e = this._entries.find(e => e.id === id);
    if (e) { e.note = note; this._save(); }
  }

  delete(id) {
    this._entries = this._entries.filter(e => e.id !== id);
    this._save();
  }

  list() { return this._entries; }

  /** Render a modal panel for the journal. Accepts callbacks for restore/delete. */
  showPanel(onRestore, onClose) {
    let panel = document.getElementById("journal-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id        = "journal-panel";
      panel.className = "stats-panel";
      document.body.appendChild(panel);
    }

    const entries = this.list();
    panel.innerHTML = `
      <div class="sp-box">
        <div class="sp-head">
          <span>Trade Journal</span>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-accent" id="jnl-save-btn" style="font-size:11px;padding:3px 10px">Save Set</button>
            <button class="sp-close" onclick="document.getElementById('journal-panel').classList.remove('open')">✕</button>
          </div>
        </div>
        <div class="sp-trades" style="max-height:460px">
          ${entries.length === 0 ? '<div class="sp-formula-empty">No saved sets yet.</div>' :
            entries.map(e => `
              <div class="jnl-entry" data-id="${e.id}">
                <div class="jnl-top">
                  <span class="jnl-name">${e.name}</span>
                  <span class="jnl-meta">${e.symbol} · ${new Date(e.createdAt).toLocaleDateString()}</span>
                  <div style="display:flex;gap:4px;margin-left:auto">
                    <button class="btn jnl-restore" data-id="${e.id}" style="font-size:10px;padding:2px 7px">Load</button>
                    <button class="btn btn-danger jnl-del" data-id="${e.id}" style="font-size:10px;padding:2px 7px">✕</button>
                  </div>
                </div>
                <textarea class="jnl-note" data-id="${e.id}" placeholder="Notes…">${e.note ?? ""}</textarea>
              </div>`).join("")}
        </div>
      </div>`;

    // Wire buttons
    panel.querySelector("#jnl-save-btn").onclick = () => {
      const name = prompt("Name this trade set:", `${this.state.symbol} set ${entries.length + 1}`);
      if (!name) return;
      const note = "";
      this.save(name, note);
      this.showPanel(onRestore, onClose);
    };

    panel.querySelectorAll(".jnl-restore").forEach(btn => {
      btn.onclick = () => {
        const id = +btn.dataset.id;
        if (this.restore(id)) onRestore?.();
      };
    });

    panel.querySelectorAll(".jnl-del").forEach(btn => {
      btn.onclick = () => {
        if (confirm("Delete this entry?")) { this.delete(+btn.dataset.id); this.showPanel(onRestore, onClose); }
      };
    });

    panel.querySelectorAll(".jnl-note").forEach(ta => {
      ta.oninput = () => this.setNote(+ta.dataset.id, ta.value);
    });

    panel.classList.add("open");
  }
}
