/**
 * SignalRuleEditor.js — Floating panel for building, testing and exporting
 * signal strategies.  One instance, mounted to #chartWrap.
 */
import { defaultStrategy, exportStrategyJSON, importStrategyJSON } from "../signals/SignalEngine.js";
import { optimizeStrategyAsync, strategyDiff } from "../signals/SignalOptimizer.js";

// Condition meta: user-readable labels + editable param fields
const COND_META = {
  ema_cross_up:     { label: "EMA cross UP (fast > slow)",   params: [{key:"fast",label:"Fast",min:2,max:100,step:1},{key:"slow",label:"Slow",min:2,max:500,step:1}] },
  ema_cross_down:   { label: "EMA cross DOWN (fast < slow)",  params: [{key:"fast",label:"Fast",min:2,max:100,step:1},{key:"slow",label:"Slow",min:2,max:500,step:1}] },
  ema_above_slow:   { label: "Fast EMA > Slow EMA",           params: [{key:"fast",label:"Fast",min:2,max:100,step:1},{key:"slow",label:"Slow",min:2,max:500,step:1}] },
  ema_below_slow:   { label: "Fast EMA < Slow EMA",           params: [{key:"fast",label:"Fast",min:2,max:100,step:1},{key:"slow",label:"Slow",min:2,max:500,step:1}] },
  price_above_ema:  { label: "Price > EMA(n)",                params: [{key:"period",label:"Period",min:2,max:500,step:1}] },
  price_below_ema:  { label: "Price < EMA(n)",                params: [{key:"period",label:"Period",min:2,max:500,step:1}] },
  macd_hist_pos:    { label: "MACD histogram flips positive",  params: [{key:"fast",label:"Fast",min:2,max:50,step:1},{key:"slow",label:"Slow",min:2,max:200,step:1},{key:"sig",label:"Signal",min:2,max:50,step:1}] },
  macd_hist_neg:    { label: "MACD histogram flips negative",  params: [{key:"fast",label:"Fast",min:2,max:50,step:1},{key:"slow",label:"Slow",min:2,max:200,step:1},{key:"sig",label:"Signal",min:2,max:50,step:1}] },
  macd_above_signal:{ label: "MACD line > Signal line",        params: [{key:"fast",label:"Fast",min:2,max:50,step:1},{key:"slow",label:"Slow",min:2,max:200,step:1},{key:"sig",label:"Signal",min:2,max:50,step:1}] },
  macd_below_signal:{ label: "MACD line < Signal line",        params: [{key:"fast",label:"Fast",min:2,max:50,step:1},{key:"slow",label:"Slow",min:2,max:200,step:1},{key:"sig",label:"Signal",min:2,max:50,step:1}] },
  rsi_oversold:     { label: "RSI crosses above oversold",     params: [{key:"period",label:"Period",min:2,max:50,step:1},{key:"level",label:"Level",min:1,max:49,step:1}] },
  rsi_overbought:   { label: "RSI crosses below overbought",   params: [{key:"period",label:"Period",min:2,max:50,step:1},{key:"level",label:"Level",min:51,max:99,step:1}] },
  rsi_in_zone:      { label: "RSI in zone (min–max)",          params: [{key:"period",label:"Period",min:2,max:50,step:1},{key:"min",label:"Min",min:1,max:99,step:1},{key:"max",label:"Max",min:1,max:99,step:1}] },
  price_above_vwap: { label: "Price > intraday VWAP",          params: [] },
  price_below_vwap: { label: "Price < intraday VWAP",          params: [] },
  volume_spike:     { label: "Volume spike",                   params: [{key:"multiplier",label:"Multiplier",min:1,max:10,step:0.1}] },
  higher_high:      { label: "Local higher-high",              params: [{key:"window",label:"Window bars",min:2,max:20,step:1}] },
  lower_low:        { label: "Local lower-low",                params: [{key:"window",label:"Window bars",min:2,max:20,step:1}] },
  // ── Trend-regime filters ──────────────────────────────────────────────────
  ema_slope_up:     { label: "EMA trending UP (regime filter)", params: [{key:"period",label:"EMA Period",min:2,max:500,step:1},{key:"lookback",label:"Slope bars",min:1,max:20,step:1}] },
  ema_slope_down:   { label: "EMA trending DOWN (regime filter)",params: [{key:"period",label:"EMA Period",min:2,max:500,step:1},{key:"lookback",label:"Slope bars",min:1,max:20,step:1}] },
  adx_trending:     { label: "ADX ≥ threshold (trend, not chop)",params: [{key:"period",label:"ADX Period",min:2,max:50,step:1},{key:"threshold",label:"Min ADX",min:10,max:60,step:1}] },
  adx_above:        { label: "ADX ≥ threshold (explicit)",        params: [{key:"period",label:"ADX Period",min:2,max:50,step:1},{key:"threshold",label:"Min ADX",min:10,max:60,step:1}] },
  // ── Probabilistic quality gates ───────────────────────────────────────────
  bb_squeeze: { label: "🎯 Bollinger Band squeeze (volatility compression)", params: [
    {key:"period",  label:"BB Period",    min:5, max:50,  step:1},
    {key:"k",       label:"Std-dev mult", min:1, max:4,   step:0.5},
    {key:"lookback",label:"Lookback bars",min:5, max:60,  step:1},
    {key:"pct",     label:"Squeeze pct",  min:0.1,max:1,  step:0.05},
  ]},
  regime_is: { label: "🧭 Regime matches direction (bull/bear)", params: [
    {key:"direction",    label:"Direction",  type:"select", options:["bull","bear"], default:"bull"},
    {key:"adx_period",   label:"ADX Period", min:7, max:30, step:1},
    {key:"adx_threshold",label:"Min ADX",    min:14,max:35, step:1},
  ]},
  regime_tradeable:     { label: "🧭 Regime: trending or breakout only", params: [
    {key:"adx_period",   label:"ADX Period",    min:7, max:30, step:1},
    {key:"adx_threshold",label:"Min ADX",        min:14,max:35, step:1},
  ]},
  forecast_clears_fees: { label: "📊 Volatility clears round-trip fees", params: [
    {key:"atr_period",  label:"ATR Period",     min:7, max:20, step:1},
    {key:"fee_rt_pct",  label:"Fee RT %",       min:0.1,max:2, step:0.05},
    {key:"rr_ratio",    label:"R:R target",     min:1, max:6,  step:0.5},
    {key:"margin",      label:"Safety margin ×",min:1, max:5,  step:0.5},
  ]},
  atr_breakout: { label: "💥 ATR breakout (elevated volatility gate)", params: [
    {key:"period",     label:"ATR Period",  min:5,  max:30, step:1},
    {key:"multiplier", label:"ATR mult",    min:1,  max:5,  step:0.1},
    {key:"lookback",   label:"Lookback",    min:5,  max:50, step:1},
  ]},
  vol_expansion: { label: "📈 Volume + ATR expansion gate", params: [
    {key:"vol_multiplier",    label:"Vol mult",      min:1,  max:5,  step:0.1},
    {key:"atr_period",        label:"ATR Period",    min:5,  max:30, step:1},
    {key:"atr_pct_threshold", label:"ATR pct ≥",     min:30, max:90, step:5},
    {key:"lookback",          label:"Lookback",      min:5,  max:50, step:1},
  ]},
  // ── Pivot point conditions ──────────────────────────────────────────────────
  price_above_pivot: { label: "📍 Price > Pivot level", params: [
    {key:"type",        label:"Formula",        type:"select", options:["classic","woodie","camarilla"], default:"classic"},
    {key:"level",       label:"Level",          type:"select", options:["pp","r1","r2","r3","s1","s2","s3"], default:"r1"},
    {key:"period_hours",label:"Period (hours)",  min:4, max:48,  step:4},
  ]},
  price_below_pivot: { label: "📍 Price < Pivot level", params: [
    {key:"type",        label:"Formula",        type:"select", options:["classic","woodie","camarilla"], default:"classic"},
    {key:"level",       label:"Level",          type:"select", options:["pp","r1","r2","r3","s1","s2","s3"], default:"s1"},
    {key:"period_hours",label:"Period (hours)",  min:4, max:48,  step:4},
  ]},
  price_near_pivot:  { label: "📍 Price near Pivot zone", params: [
    {key:"type",        label:"Formula",        type:"select", options:["classic","woodie","camarilla"], default:"classic"},
    {key:"level",       label:"Level",          type:"select", options:["pp","r1","r2","r3","s1","s2","s3"], default:"s2"},
    {key:"period_hours",label:"Period (hours)",  min:4, max:48,  step:4},
    {key:"tolerance",   label:"Tolerance (×ATR)",min:0.1,max:3, step:0.1},
    {key:"atr_period",  label:"ATR Period",      min:7, max:20,  step:1},
  ]},
};

export class SignalRuleEditor {
  constructor(container) {
    this.container = container;
    this.strategy  = null;   // set by engine after construction
    this.onRun      = null;   // callback: (strategy) => void
    this.onExport   = null;   // callback: (strategy, stats) => void
    this.onOptimize = null;   // callback: (strategy) => void  (async, results via showOptimizeResults)
    this.onCancel   = null;   // callback: () => void  — terminate active worker
    this.onGenerateReport = null; // callback: (opts) => void — trigger full report generation
    this.onSendToOptimizer = null; // callback: (strategy) => void — open standalone Optimizer panel
    this._visible  = false;
    this._lastStats = null;

    this._buildDOM();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  show() {
    this._visible = true;
    this._panel.style.display = "flex";
    this._refresh();
  }

  hide() {
    this._visible = false;
    this._panel.style.display = "none";
  }

  toggle() {
    this._visible ? this.hide() : this.show();
    return this._visible;
  }

  /** Called by engine after a scan completes */
  updateStats(stats, signalCount, tradeCount) {
    this._lastStats = stats;
    if (!this._visible) return;
    this._renderStats(stats, signalCount, tradeCount);
  }

  /**
   * Show / update the progress bar while the optimizer runs.
   * Called from Engine on each worker progress message.
   *
   * @param {number|string} phase   phase id (0,1,2,3,'3b',4,5)
   * @param {number}        pct     0–100, or -1 for indeterminate
   * @param {string}        label   human-readable status label
   */
  showProgress(phase, pct, label) {
    const q   = id => this._panel.querySelector(`#${id}`);
    const wrap = q("sreProgressWrap");
    if (!wrap) return;

    wrap.style.display = "block";
    q("sreOptimize").disabled  = true;
    q("sreOptCancel").style.display = "inline-flex";
    q("sreRun").disabled = true;

    if (label) {
      const phases = { 0:"P0", 1:"P1", 2:"P2", 3:"P3", "3b":"P3b", 4:"P4 walk-fwd", 5:"P5 SQS" };
      q("sreProgressLabel").textContent = label;

      // Step dots: show which passes are complete
      const order  = ["0","1","2","3","3b","4","5"];
      const curIdx = order.indexOf(String(phase));
      const sub    = order.map((p, i) => {
        const lbl   = phases[p] ?? p;
        const cls   = i < curIdx ? "done" : i === curIdx ? "active" : "pending";
        return `<span class="sre-prog-step sre-prog-step-${cls}">${lbl}</span>`;
      }).join("");
      q("sreProgressSub").innerHTML = sub;
    }

    const bar   = q("sreProgressBar");
    const pulse = q("sreProgressPulse");
    if (pct >= 0) {
      bar.style.width   = `${Math.min(pct, 100)}%`;
      pulse.style.display = "none";
    } else {
      // Indeterminate — show the animated pulse stripe
      bar.style.width   = "30%";
      pulse.style.display = "block";
    }
  }

  /** Hide the progress bar and restore buttons when optimizer completes or is cancelled. */
  hideProgress() {
    const q   = id => this._panel.querySelector(`#${id}`);
    const wrap = q("sreProgressWrap");
    if (!wrap) return;
    wrap.style.display = "none";
    q("sreOptimize").disabled = false;
    q("sreOptimize").innerHTML = "&#127919; Optimize";
    q("sreOptCancel").style.display = "none";
    q("sreRun").disabled = false;
  }

  // ─── DOM construction ────────────────────────────────────────────────────

  _buildDOM() {
    const p = document.createElement("div");
    p.id = "signalRuleEditor";
    p.className = "sre-panel";
    p.style.display = "none";
    p.innerHTML = `
      <div class="sre-header">
        <span class="sre-title">⚡ Signal Rules</span>
        <div class="sre-header-btns">
          <button class="btn btn-icon sre-close" title="Close">✕</button>
        </div>
      </div>

      <div class="sre-body">

        <!-- Strategy meta -->
        <div class="sre-row">
          <label class="sre-lbl">Name</label>
          <input  id="sreName"      class="sre-input" type="text" placeholder="Strategy name" />
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Direction</label>
          <select id="sreDirection" class="sre-select">
            <option value="long">&#9650; Long (buy)</option>
            <option value="short">&#9660; Short (sell)</option>
            <option value="both">&#9650;&#9660; Both directions</option>
          </select>
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Combine with</label>
          <select id="sreLogic" class="sre-select">
            <option value="AND">AND — all conditions required</option>
            <option value="OR">OR — any condition triggers</option>
          </select>
        </div>

        <div class="sre-divider"></div>

        <!-- Entry conditions list -->
        <div class="sre-section-label">ENTRY CONDITIONS</div>
        <div id="sreCondList" class="sre-cond-list"></div>
        <button id="sreAddCond" class="btn sre-add-btn">+ Add Condition</button>

        <div class="sre-divider"></div>

        <!-- Exit params -->
        <div class="sre-section-label">EXIT</div>
        <div class="sre-row">
          <label class="sre-lbl">Stop type</label>
          <select id="sreStopType" class="sre-select">
            <option value="atr">ATR ×</option>
            <option value="pct">% of price</option>
          </select>
          <input id="sreStopVal" class="sre-input sre-num" type="number" min="0.1" max="20" step="0.1" value="2.0" />
          <span  class="sre-hint" id="sreStopHint">ATR period 14</span>
        </div>
        <div class="sre-row">
          <label class="sre-lbl">R:R ratio</label>
          <input id="sreRR"       class="sre-input sre-num" type="number" min="0.5" max="20" step="0.1" value="2.5" />
          <span  class="sre-hint">take profit</span>
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Max bars</label>
          <input id="sreMaxBars"  class="sre-input sre-num" type="number" min="1"   max="500" step="1"  value="48"  />
          <span  class="sre-hint">then close at market</span>
        </div>

        <div class="sre-divider"></div>

        <!-- Risk params -->
        <div class="sre-section-label">RISK / POSITION SIZE</div>
        <div class="sre-row">
          <label class="sre-lbl">Account $</label>
          <input id="sreAccount"  class="sre-input sre-num" type="number" min="1" step="1" value="1000" />
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Risk % / trade</label>
          <input id="sreRiskPct"  class="sre-input sre-num" type="number" min="0.1" max="20" step="0.1" value="1.0" />
        </div>

        <div class="sre-divider"></div>

        <!-- Fees -->
        <div class="sre-divider"></div>
        <div class="sre-section-label">FEES</div>
        <div class="sre-row">
          <label class="sre-lbl">Tier preset</label>
          <select id="sreFeePreset" class="sre-select">
            <option value="kraken_starter">Kraken Starter  (0.40% / 0.25%)</option>
            <option value="kraken_tier1">Kraken Tier 1  (0.25% / 0.15%)</option>
            <option value="kraken_tier2">Kraken Tier 2  (0.20% / 0.12%)</option>
            <option value="kraken_tier3">Kraken Tier 3  (0.14% / 0.10%)</option>
            <option value="kraken_tier4">Kraken Tier 4  (0.10% / 0.06%)</option>
            <option value="kraken_pro">Kraken Pro Max (0.01% / 0.00%)</option>
            <option value="zero">No fees (0%)</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Entry fee %</label>
          <input id="sreEntryFee" class="sre-input sre-num" type="number" min="0" max="2" step="0.01" value="0.40" />
          <span class="sre-hint">taker (market)</span>
        </div>
        <div class="sre-row">
          <label class="sre-lbl">Exit fee %</label>
          <input id="sreExitFee"  class="sre-input sre-num" type="number" min="0" max="2" step="0.01" value="0.25" />
          <span class="sre-hint">maker (limit TP/SL)</span>
        </div>

        <!-- Backtest stats -->
        <div class="sre-section-label">BACKTEST RESULTS</div>
        <div id="sreStats" class="sre-stats">Run scan to see results.</div>

        <div class="sre-divider"></div>

        <!-- Optimizer results (hidden until run) -->
        <div id="sreOptSection" style="display:none">
          <div class="sre-section-label">OPTIMIZER RESULTS</div>
          <div id="sreOptResults" class="sre-opt-results"></div>
        </div>

      </div><!-- /sre-body -->

      <div class="sre-footer">
        <button id="sreRun"      class="btn btn-accent sre-btn-run">&#9654; Run Scan</button>
        <button id="sreOptimize" class="btn sre-btn-opt" title="Auto-find best parameters across ~400 combos">&#127919; Optimize</button>
        <button id="sreOptCancel" class="btn btn-danger sre-btn-sm" style="display:none" title="Cancel optimizer">&#9632; Cancel</button>
        <label class="sre-opt-chk" title="After a failed run, automatically test 7 built-in pivot strategies looking for PF > 1.0">
          <input type="checkbox" id="sreAutoPivot"> Auto-Pivot
        </label>
        <label class="sre-opt-chk" title="Re-run the best result on higher resampled timeframes and show averaged stats">
          <input type="checkbox" id="sreMultiTF"> Multi-TF
        </label>
        <label class="sre-opt-chk" title="When lower TF is unprofitable, weight 4h/1h results higher and promote the best">
          <input type="checkbox" id="srePreferHigherTF"> Prefer Higher TF
        </label>
        <button id="sreGenReport" class="btn sre-opt-dl-report" title="Run full optimizer + backtest all TFs and pivot strategies, then download report">&#128202; Full Report</button>
        <button id="sreSendToOpt" class="btn sre-btn-sm sre-btn-accent2" title="Copy current strategy to the standalone Optimizer panel">&#8599; Send to Optimizer</button>
        <button id="sreClear"    class="btn btn-danger sre-btn-sm">Clear</button>
        <button id="sreExport"   class="btn sre-btn-sm" disabled>&#11015; Export JSON</button>
        <button id="sreImport"   class="btn sre-btn-sm">&#11014; Import JSON</button>
        <input  id="sreImportFile" type="file" accept=".json" style="display:none" />
      </div>

      <!-- Optimizer progress bar (hidden until running) -->
      <div id="sreProgressWrap" style="display:none" class="sre-progress-wrap">
        <div class="sre-progress-label" id="sreProgressLabel">Optimizing…</div>
        <div class="sre-progress-track">
          <div class="sre-progress-bar" id="sreProgressBar" style="width:0%"></div>
          <div class="sre-progress-pulse" id="sreProgressPulse"></div>
        </div>
        <div class="sre-progress-sub" id="sreProgressSub"></div>
      </div>
    `;

    this.container.appendChild(p);
    this._panel = p;
    this._bindEvents();
  }

  _bindEvents() {
    const q = id => this._panel.querySelector(`#${id}`);

    q("sre-close") || this._panel.querySelector(".sre-close")
      ?.addEventListener("click", () => this.hide());

    q("sreRun")?.addEventListener("click", () => this._flush() && this.onRun?.(this.strategy));

    q("sreOptimize")?.addEventListener("click", () => {
      if (!this._flush()) return;
      const autoPivot      = q("sreAutoPivot")?.checked       ?? false;
      const multiTF         = q("sreMultiTF")?.checked         ?? false;
      const preferHigherTF  = q("srePreferHigherTF")?.checked  ?? false;
      this.onOptimize?.(this.strategy, { autoPivot, multiTF, preferHigherTF });
    });

    q("sreOptCancel")?.addEventListener("click", () => {
      this.onCancel?.();
      this.hideProgress();
    });
    q("sreClear")?.addEventListener("click", () => {
      if (confirm("Clear all computed signals from chart?")) {
        this.strategy.backtest_summary = null;
        this._lastStats = null;
        this._renderStats(null, 0, 0);
        this.onRun?.(null);  // null = clear
      }
    });

    q("sreExport")?.addEventListener("click", () => {
      if (this._flush()) this.onExport?.(this.strategy, this._lastStats);
    });

    q("sreImport")?.addEventListener("click", () => q("sreImportFile")?.click());

    q("sreGenReport")?.addEventListener("click", () => {
      if (!this._flush()) return;
      const preferHigherTF = q("srePreferHigherTF")?.checked ?? false;
      const baseTF         = this._lastBaseTF ?? "15m";
      this.onGenerateReport?.({ strategy: this.strategy, preferHigherTF, baseTF });
    });
    q("sreSendToOpt")?.addEventListener("click", () => {
      if (!this._flush()) return;
      if (typeof this.onSendToOptimizer === "function") {
        this.onSendToOptimizer(this.strategy);
      } else {
        console.warn('[SignalRuleEditor] onSendToOptimizer not wired — set engine.signalEditor.onSendToOptimizer');
      }
    });
    q("sreImportFile")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          this.strategy = importStrategyJSON(ev.target.result);
          this._refresh();
          this.onRun?.(this.strategy);
        } catch(err) {
          alert("Import failed: " + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    q("sreAddCond")?.addEventListener("click", () => this._addCondition());

    // Fee preset selector
    q("sreFeePreset")?.addEventListener("change", (e) => {
      const presets = {
        kraken_starter: [0.40, 0.25],
        kraken_tier1:   [0.25, 0.15],
        kraken_tier2:   [0.20, 0.12],
        kraken_tier3:   [0.14, 0.10],
        kraken_tier4:   [0.10, 0.06],
        kraken_pro:     [0.01, 0.00],
        zero:           [0.00, 0.00],
      };
      const vals = presets[e.target.value];
      if (vals) {
        q("sreEntryFee").value = vals[0];
        q("sreExitFee").value  = vals[1];
      }
    });
    q("sreEntryFee")?.addEventListener("change", () => this._syncFeePreset());
    q("sreExitFee")?.addEventListener("change",  () => this._syncFeePreset());
  }

  _syncFeePreset() {
    const q = id => this._panel.querySelector(`#${id}`);
    const entry = +q("sreEntryFee")?.value;
    const exit  = +q("sreExitFee")?.value;
    const presets = [
      { key: "kraken_starter", e: 0.40, x: 0.25 },
      { key: "kraken_tier1",   e: 0.25, x: 0.15 },
      { key: "kraken_tier2",   e: 0.20, x: 0.12 },
      { key: "kraken_tier3",   e: 0.14, x: 0.10 },
      { key: "kraken_tier4",   e: 0.10, x: 0.06 },
      { key: "kraken_pro",     e: 0.01, x: 0.00 },
      { key: "zero",           e: 0.00, x: 0.00 },
    ];
    const match = presets.find(p => p.e === entry && p.x === exit);
    if (q("sreFeePreset")) q("sreFeePreset").value = match ? match.key : "custom";
  }

  /** Called by engine after optimization completes */
  showOptimizeResults(result, originalStrategy) {
    const sec = this._panel.querySelector("#sreOptSection");
    const el  = this._panel.querySelector("#sreOptResults");
    if (!sec || !el) return;

    // Keep a reference so _downloadOptReport can access everything later
    this._lastOptResult   = result;
    this._lastOptOriginal = originalStrategy;

    const { topResults, passStats } = result;
    sec.style.display = "block";

    if (!topResults?.length) {
      el.innerHTML = `<div class="sre-stat-warn">No signals fired on any combo — try loading more bars (need at least 200), enabling more conditions, or switching to OR logic.</div>`;
      return;
    }

    // Build top-5 cards
    const cards = topResults.map((r, i) => {
      const s  = r.stats;
      const diffs = strategyDiff(originalStrategy, r.strategy);
      const diffHtml = diffs.length
        ? diffs.map(d => `<span class="sre-opt-diff">${d.label}: <s>${d.from}</s> → <b>${d.to}</b></span>`).join(" ")
        : `<span class="sre-stat-hint">No param changes from current</span>`;
      const pf  = s.profit_factor != null ? s.profit_factor.toFixed(2) : "∞";
      const dir = r.strategy.entry.direction;
      const dirBadge = dir === "long"  ? `<span class="sre-dir-badge sre-dir-long">&#9650; LONG</span>`
                     : dir === "short" ? `<span class="sre-dir-badge sre-dir-short">&#9660; SHORT</span>`
                     :                   `<span class="sre-dir-badge sre-dir-both">&#9650;&#9660; BOTH</span>`;
      const feesUsd  = s.total_fees_usd ?? 0;
      const grossUsd = s.gross_pnl_usd  ?? s.net_pnl_usd;
      const feesBadge = feesUsd > 0
        ? `<span class="sre-opt-kpi sre-opt-fees">💸-$${feesUsd.toFixed(0)} fees · gross $${grossUsd >= 0 ? "+" : ""}${grossUsd.toFixed(0)}</span>`
        : "";
      const isActive = i === 0 ? " sre-opt-card-active" : "";
      // A sub-threshold result fired trades but failed score guards (too few trades,
      // low PF, excessive fee drag, etc.). Mark it clearly so the user knows.
      const isSubThreshold = !isFinite(r.score);
      const subBadge = isSubThreshold
        ? `<span class="sre-opt-kpi sre-opt-subthreshold" title="Below optimizer thresholds (low trade count, PF, or R:R) — study only">⚠ sub-threshold</span>`
        : "";
      const pivotBadge = r.isPivot
        ? `<span class="sre-opt-kpi sre-opt-pivot" title="Built-in pivot strategy — not derived from your conditions">📌 Pivot</span>`
        : "";
      const oosBadge = r.oosPass === true
        ? `<span class="sre-opt-kpi sre-oos-pass" title="Survived out-of-sample validation">✓ OOS</span>`
        : r.oos
          ? `<span class="sre-opt-kpi sre-oos-fail" title="Did not hold in OOS window">✗ OOS</span>`
          : "";
      return `<div class="sre-opt-card${isActive}${isSubThreshold ? ' sre-opt-card-subthreshold' : ''}" data-idx="${i}">
        <div class="sre-opt-card-header">
          <span class="sre-opt-rank">#${i + 1}</span>
          ${dirBadge}
          ${subBadge}
          ${pivotBadge}
          ${oosBadge}
          <span class="sre-opt-kpi ${s.net_pnl_usd >= 0 ? "up" : "dn"}">${s.net_pnl_usd >= 0 ? "+" : ""}$${s.net_pnl_usd.toFixed(0)} net</span>
          <span class="sre-opt-kpi">WR ${s.win_rate}%</span>
          <span class="sre-opt-kpi">PF ${pf}</span>
          <span class="sre-opt-kpi">${s.avg_rr.toFixed(1)}R</span>
          <span class="sre-opt-kpi">${s.total}t</span>
          <button class="btn sre-opt-apply" data-idx="${i}">Apply</button>
          <button class="btn sre-opt-export" data-idx="${i}" title="Export strategy JSON — no need to Apply first">&#11015;</button>
        </div>
        ${feesBadge ? `<div class="sre-opt-card-fees">${feesBadge}</div>` : ""}
        <div class="sre-opt-diffs">${diffHtml}</div>
      </div>`;
    }).join("");

    const pfBadge = passStats.foundProfitable
      ? `<span class="sre-opt-badge sre-badge-ok">✓ Profitable found</span>`
      : passStats.usedFallback
        ? `<span class="sre-opt-badge sre-badge-err">⚠ All combos below threshold — best-of-worst shown. Try more bars, OR logic, or looser conditions.</span>`
        : `<span class="sre-opt-badge sre-badge-warn">⚠ No profitable — showing best</span>`;
    const pivotBadge = (passStats.pivotsTested ?? 0) > 0
      ? `<span class="sre-opt-badge sre-badge-pivot">📌 ${passStats.pivotsTested} pivots tested</span>` : "";
    const pivotFallbackBanner = (passStats.pivotsTested ?? 0) > 0 && !passStats.foundProfitable
      ? `<div class="sre-opt-banner sre-banner-orange">📍 Pivot Fallback Activated — ${passStats.pivotsTested} pivot strategies scanned. Check pivot results above.</div>` : "";
    const promotedBanner = passStats.promotedToHigherTF
      ? `<div class="sre-opt-banner sre-banner-blue">📈 Best result promoted to higher TF — consider trading on higher timeframe data.</div>` : "";
    const _mtf = passStats.multiTFStats;
    const mtfBadge = _mtf
      ? _mtf.all_zero
        ? `<span class="sre-opt-badge sre-badge-err" title="All TFs returned 0 trades — check browser console for debug info">⚠ Multi-TF: all ${_mtf.per_tf?.length ?? 0} TFs zero trades</span>`
        : `<span class="sre-opt-badge sre-badge-dim" title="${(_mtf.per_tf ?? []).map(x => x.tf + ':' + (x.zero_signals ? '0t' : (x.stats?.total ?? '?') + 't PF' + (x.stats?.profit_factor ?? '?'))).join(' | ')}">TF avg PF ${_mtf.avg_profit_factor} (${_mtf.tfs.length}/${(_mtf.per_tf?.length ?? _mtf.tfs.length)} TFs)</span>`
      : "";
    const expBadge = passStats.expandedSearch
      ? `<span class="sre-opt-badge sre-badge-dim">Expanded param ranges</span>` : "";

    const passCounts = [
      passStats.p0Combos != null ? `P0 cond: ${passStats.p0Combos}` : null,
      passStats.p1Combos != null ? `P1 entry: ${passStats.p1Combos}` : null,
      passStats.p2Combos != null ? `P2 exit: ${passStats.p2Combos}` : null,
      passStats.p3Combos != null ? `P3 dir: ${passStats.p3Combos}` : null,
    ].filter(Boolean).join(" · ");

    const oosBadge  = passStats.oosValidCount > 0
      ? `<span class="sre-opt-badge sre-badge-ok">✓ ${passStats.oosValidCount} OOS-validated</span>` : "";
    const sqsBadge  = passStats.recommendedMinSQS > 0
      ? `<span class="sre-opt-badge sre-badge-dim">Min SQS: ${passStats.recommendedMinSQS}</span>` : "";

    el.innerHTML = cards + pivotFallbackBanner + promotedBanner +
      `<div class="sre-opt-footer">
        ${pfBadge}${expBadge}${oosBadge}${sqsBadge}${pivotBadge}${mtfBadge}
        <span>${passStats.totalCombos} combos · ${passStats.elapsedMs}ms · ${passStats.validResults} valid</span>
        <span class="sre-opt-passes">${passCounts}</span>
        <button class="btn sre-opt-dl-report" id="sreOptDlReport" title="Download the full optimizer run as JSON — includes all ranked strategies, pass stats, ensemble data and original strategy">&#11015; Export Report</button>
      </div>`;

    // Wire Apply buttons
    el.querySelectorAll(".sre-opt-apply").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = +btn.dataset.idx;
        const chosen = topResults[idx]?.strategy;
        if (!chosen) return;
        this.strategy = JSON.parse(JSON.stringify(chosen));
        this._refresh();
        this.onRun?.(this.strategy);
        // Highlight selected
        el.querySelectorAll(".sre-opt-card").forEach((c, i) =>
          c.classList.toggle("sre-opt-card-active", i === idx));
      });
    });

    // Wire per-card Export buttons (works for losing and winning results alike)
    el.querySelectorAll(".sre-opt-export").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx     = +btn.dataset.idx;
        const chosen  = topResults[idx]?.strategy;
        const stats   = topResults[idx]?.stats;
        if (!chosen) return;
        // Export a deep-copy so callers cannot mutate the live result
        this.onExport?.(JSON.parse(JSON.stringify(chosen)), stats ?? {});
      });
    });

    // Wire Export Report button
    el.querySelector("#sreOptDlReport")?.addEventListener("click", () => this._downloadOptReport());
  }

  _refresh() {
    if (!this.strategy) return;
    const q = id => this._panel.querySelector(`#${id}`);
    const e  = this.strategy.entry;
    const ex = this.strategy.exit;
    const r  = this.strategy.risk;

    q("sreName").value      = this.strategy.meta.name || "";
    q("sreDirection").value = e.direction  || "long";
    // Ensure the dropdown actually has the value (e.g. "short" after optimizer)
    if (q("sreDirection").value !== (e.direction || "long")) {
      // Value not in options yet — force it
      const opt = document.createElement("option");
      opt.value = e.direction; opt.textContent = e.direction;
      q("sreDirection").appendChild(opt);
      q("sreDirection").value = e.direction;
    }
    q("sreLogic").value     = e.logic      || "AND";
    q("sreStopType").value  = ex.stop_loss?.type || "atr";
    q("sreStopVal").value   = ex.stop_loss?.params?.multiplier ?? ex.stop_loss?.params?.pct ?? 2.0;
    q("sreRR").value        = ex.take_profit?.ratio ?? 2.5;
    q("sreMaxBars").value   = ex.max_bars ?? 48;
    q("sreAccount").value   = r.account_size ?? 10000;
    q("sreRiskPct").value   = r.risk_per_trade_pct ?? 1.0;

    const f = this.strategy.fees ?? { entry_pct: 0.40, exit_pct: 0.25 };
    q("sreEntryFee").value  = f.entry_pct ?? 0.40;
    q("sreExitFee").value   = f.exit_pct  ?? 0.25;
    // Sync preset selector
    this._syncFeePreset();

    this._renderCondList();
    this._renderStats(this._lastStats, null, null);
  }

  _renderCondList() {
    const list = this._panel.querySelector("#sreCondList");
    list.innerHTML = "";
    for (let i = 0; i < this.strategy.entry.conditions.length; i++) {
      list.appendChild(this._buildCondRow(i));
    }
  }

  _buildCondRow(idx) {
    const cond = this.strategy.entry.conditions[idx];
    const meta = COND_META[cond.id] || { label: cond.id, params: [] };

    const row = document.createElement("div");
    row.className = "sre-cond-row" + (cond.enabled === false ? " sre-cond-disabled" : "");
    row.dataset.idx = idx;

    // Toggle checkbox
    const tog = document.createElement("input");
    tog.type    = "checkbox";
    tog.checked = cond.enabled !== false;
    tog.className = "sre-cond-toggle";
    tog.title   = "Enable / disable";
    tog.addEventListener("change", () => {
      this.strategy.entry.conditions[idx].enabled = tog.checked;
      row.classList.toggle("sre-cond-disabled", !tog.checked);
    });

    // Condition id selector
    const sel = document.createElement("select");
    sel.className = "sre-select sre-cond-sel";
    for (const [id, m] of Object.entries(COND_META)) {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = m.label;
      if (id === cond.id) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const newId = sel.value;
      const newMeta = COND_META[newId];
      // Re-seed params
      const newParams = {};
      for (const p of (newMeta?.params || [])) newParams[p.key] = p.min + Math.floor((p.max - p.min) * 0.2);
      this.strategy.entry.conditions[idx] = { id: newId, enabled: cond.enabled !== false, params: newParams, label: newMeta?.label || newId };
      this._renderCondList();
    });

    // Param inputs
    const paramWrap = document.createElement("div");
    paramWrap.className = "sre-param-wrap";
    for (const pDef of meta.params) {
      const lbl = document.createElement("span");
      lbl.className = "sre-param-lbl";
      lbl.textContent = pDef.label;

      const inp = document.createElement("input");
      inp.type  = "number";
      inp.className = "sre-input sre-num sre-param-inp";
      inp.min   = pDef.min; inp.max = pDef.max; inp.step = pDef.step;
      inp.value = cond.params?.[pDef.key] ?? pDef.min;
      inp.addEventListener("change", () => {
        this.strategy.entry.conditions[idx].params[pDef.key] = +inp.value;
      });
      paramWrap.appendChild(lbl);
      paramWrap.appendChild(inp);
    }

    // Remove button
    const rem = document.createElement("button");
    rem.className = "btn btn-icon sre-rem";
    rem.title     = "Remove condition";
    rem.textContent = "✕";
    rem.addEventListener("click", () => {
      this.strategy.entry.conditions.splice(idx, 1);
      this._renderCondList();
    });

    row.appendChild(tog);
    row.appendChild(sel);
    row.appendChild(paramWrap);
    row.appendChild(rem);
    return row;
  }

  _addCondition() {
    this.strategy.entry.conditions.push({
      id: "ema_cross_up", enabled: true,
      params: { fast: 9, slow: 21 },
      label: COND_META.ema_cross_up.label,
    });
    this._renderCondList();
  }

  _renderStats(stats, sigCount, tradeCount) {
    const el = this._panel.querySelector("#sreStats");
    const exportBtn = this._panel.querySelector("#sreExport");
    if (!stats || stats.total === 0) {
      el.innerHTML = sigCount === 0 && sigCount !== null
        ? `<span class="sre-stat-warn">No signals fired — try loosening conditions or switching to OR logic.</span>`
        : `<span class="sre-stat-hint">Run scan to see results.</span>`;
      if (exportBtn) exportBtn.disabled = true;
      return;
    }

    const pf      = stats.profit_factor != null ? stats.profit_factor.toFixed(2) : "∞";
    const hasFees = (stats.total_fees_usd ?? 0) > 0;
    const feesLine = hasFees
      ? `<div class="sre-fees-drag">💸 Fees: -$${stats.total_fees_usd.toFixed(0)} &nbsp;·&nbsp; Gross (pre-fee): ${stats.gross_pnl_usd >= 0 ? "+" : ""}$${stats.gross_pnl_usd.toFixed(0)}</div>`
      : "";

    el.innerHTML = `
      <div class="sre-stat-grid">
        <div class="sre-stat-cell">
          <div class="sre-stat-val ${stats.net_pnl_usd >= 0 ? "up" : "dn"}">${stats.net_pnl_usd >= 0 ? "+" : ""}$${stats.net_pnl_usd.toFixed(0)}</div>
          <div class="sre-stat-key">Net PnL</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${stats.win_rate}%</div>
          <div class="sre-stat-key">Win Rate</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${stats.avg_rr.toFixed(2)}R</div>
          <div class="sre-stat-key">Avg R:R</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${pf}</div>
          <div class="sre-stat-key">Prof. Factor</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${stats.total}</div>
          <div class="sre-stat-key">Trades</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val dn">$${stats.max_drawdown_usd.toFixed(0)}</div>
          <div class="sre-stat-key">Max DD</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${stats.tp_pct}%</div>
          <div class="sre-stat-key">TP hits</div>
        </div>
        <div class="sre-stat-cell">
          <div class="sre-stat-val">${stats.avg_bars_held}b</div>
          <div class="sre-stat-key">Avg hold</div>
        </div>
      </div>
      ${feesLine}
      ${(() => {
        // Warn if round-trip fee per trade exceeds 30% of the risk dollar
        const acct      = this.strategy?.risk?.account_size    ?? 1000;
        const riskPct   = this.strategy?.risk?.risk_per_trade_pct ?? 1.0;
        const entryFee  = this.strategy?.fees?.entry_pct ?? 0;
        const exitFee   = this.strategy?.fees?.exit_pct  ?? 0;
        const riskDollar = acct * riskPct / 100;
        // Approx fee on a typical trade: assume $acct notional (worst-case 1:1)
        const feesPerTrade = acct * (entryFee + exitFee) / 100;
        const feePct = riskDollar > 0 ? feesPerTrade / riskDollar * 100 : 0;
        if (feePct >= 30) {
          return `<div class="sre-fee-warn">⚠ Fees (~$${feesPerTrade.toFixed(2)}/trade) are ${feePct.toFixed(0)}% of your ` +
                 `$${riskDollar.toFixed(2)} risk — consider lowering fee tier or increasing account size.</div>`;
        }
        return "";
      })()}
      <div class="sre-stat-footer">${tradeCount} trades from ${sigCount} signals · ${stats.sl_pct}% stopped out · ${stats.exp_pct}% expired</div>
    `;
    if (exportBtn) exportBtn.disabled = false;
  }

  /**
   * Downloads the complete optimizer run as a self-contained JSON file.
   * Includes every ranked strategy with its full stats and diffs, all pass
   * diagnostics, the ensemble blend result, and the original strategy that
   * was submitted — everything needed to study, compare, or re-import.
   */
  _downloadOptReport() {
    const result   = this._lastOptResult;
    const original = this._lastOptOriginal;
    if (!result) return;

    const { topResults, passStats } = result;
    const sym = this.strategy?.meta?.symbol    ?? "unknown";
    const tf  = this.strategy?.meta?.timeframe ?? "unknown";

    const payload = {
      exported_at:       new Date().toISOString(),
      symbol:            sym,
      timeframe:         tf,
      pass_stats: {
        total_combos:        passStats.totalCombos       ?? 0,
        valid_results:       passStats.validResults      ?? 0,
        elapsed_ms:          passStats.elapsedMs         ?? 0,
        found_profitable:    passStats.foundProfitable   ?? false,
        expanded_search:     passStats.expandedSearch    ?? false,
        oos_valid_count:     passStats.oosValidCount     ?? 0,
        recommended_min_sqs: passStats.recommendedMinSQS ?? 0,
        p0_combos:           passStats.p0Combos          ?? null,
        p1_combos:           passStats.p1Combos          ?? null,
        p2_combos:           passStats.p2Combos          ?? null,
        p3_combos:           passStats.p3Combos          ?? null,
        aborted:             passStats.aborted           ?? false,
        sqs_sweep:           passStats.sqsSweepResults   ?? [],
        ensemble:            passStats.ensemble          ?? null,
        used_fallback:       passStats.usedFallback      ?? false,
        pivots_tested:       passStats.pivotsTested      ?? 0,
        multi_tf_stats:      passStats.multiTFStats      ?? null,
      },
      results: topResults.map((r, i) => ({
        rank:      i + 1,
        strategy:  r.strategy,
        stats:     r.stats,
        oos_pass:  r.oosPass  ?? null,
        oos_stats: r.oos      ?? null,
        score:     r.score    ?? null,
        diffs:     original   ? strategyDiff(original, r.strategy) : [],
      })),
      original_strategy: original ?? null,
    };

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `opt_report_${sym}_${tf}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Read all form values into this.strategy, return true if valid */
  _flush() {
    if (!this.strategy) return false;
    const q = id => this._panel.querySelector(`#${id}`);
    const e  = this.strategy.entry;
    const ex = this.strategy.exit;
    const r  = this.strategy.risk;

    this.strategy.meta.name      = q("sreName").value || "Unnamed Strategy";
    this.strategy.meta.timeframe = this.strategy.meta.timeframe;  // set by engine
    e.direction                  = q("sreDirection").value;
    e.logic                      = q("sreLogic").value;

    const stopType = q("sreStopType").value;
    const stopVal  = +q("sreStopVal").value;
    ex.stop_loss = stopType === "atr"
      ? { type: "atr", params: { period: 14, multiplier: stopVal } }
      : { type: "pct", params: { pct: stopVal } };

    ex.take_profit     = { type: "rr",  ratio: +q("sreRR").value };
    ex.max_bars        = +q("sreMaxBars").value;
    r.account_size       = +q("sreAccount").value;
    r.risk_per_trade_pct = +q("sreRiskPct").value;

    if (!this.strategy.fees) this.strategy.fees = {};
    this.strategy.fees.entry_pct = +q("sreEntryFee").value;
    this.strategy.fees.exit_pct  = +q("sreExitFee").value;

    return true;
  }
}
