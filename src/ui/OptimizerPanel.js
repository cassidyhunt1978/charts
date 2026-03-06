/**
 * OptimizerPanel.js — Full-screen Optimizer overlay for MarketMind Charts.
 *
 * Standalone class, zero framework deps.  Mounts into document.body as a
 * fixed-position overlay so it stacks above the chart.
 *
 * Lifecycle:
 *   const panel = new OptimizerPanel(engine);
 *   panel.mount();
 *   panel.toggle();          // open / close
 *   panel.loadStrategy(s);   // pre-fill from SignalRuleEditor "Send to Optimizer"
 *
 * Public callbacks (set before mount or any time):
 *   panel.onRunComplete = (result) => { ... }
 *
 * The panel talks to the engine via:
 *   engine.state     — symbol, timeframe
 *   engine.runOptimizer(bars, strategy, opts)  — returns Promise<result>
 *   engine.generateOptimizerReport(result, opts) — builds + downloads report
 */

import { makeOptimizerProvider } from '../data/LiveProvider.js';
import { ReportGenerator }       from '../util/ReportGenerator.js';

// Panel HTML template ──────────────────────────────────────────────────────────
const PANEL_HTML = `
<div class="opt-panel" id="optimizerPanel" role="dialog" aria-label="Strategy Optimizer" hidden>
  <div class="opt-panel-inner">

    <!-- ── Header ── -->
    <div class="opt-header">
      <span class="opt-header-icon">⚙</span>
      <span class="opt-header-title">Strategy Optimizer</span>
      <span class="opt-header-sub" id="optHeaderSub">Ready</span>
      <button class="btn opt-close-btn" id="optCloseBtn" title="Close optimizer (Esc)">✕</button>
    </div>

    <div class="opt-body">

      <!-- ── Left column: controls ── -->
      <div class="opt-col-controls">

        <!-- Context row -->
        <div class="opt-section">
          <div class="opt-section-title">Context</div>
          <div class="opt-ctx-row">
            <span class="opt-ctx-label">Symbol</span>
            <span class="opt-ctx-value" id="optCtxSymbol">–</span>
            <span class="opt-ctx-label">Base TF</span>
            <span class="opt-ctx-value" id="optCtxTF">–</span>
            <span class="opt-ctx-label">Bars loaded</span>
            <span class="opt-ctx-value" id="optCtxBars">–</span>
          </div>
          <div class="opt-field-row" style="margin-top:6px">
            <label class="opt-field-label" for="optHistoryDays">History to fetch</label>
            <select id="optHistoryDays" class="opt-input">
              <option value="0">Current (chart bars only)</option>
              <option value="90">90 days (~130 k bars)</option>
              <option value="180">180 days (~260 k bars)</option>
              <option value="365" selected>1 year (~525 k bars)</option>
              <option value="730">2 years (~1 M bars)</option>
            </select>
            <span class="opt-field-hint">Re-fetches data fresh from the API before running</span>
          </div>
          <div id="optSeedInfo" class="opt-seed-badge" style="display:none">
            📌 Seeded from Signal Editor
          </div>
        </div>

        <!-- Feature toggles -->
        <div class="opt-section">
          <div class="opt-section-title">Optimizer Features</div>
          <label class="opt-toggle-row" title="Test the best result across 1m, 5m, 15m, 1h, 4h, 1d and report per-TF PF">
            <input type="checkbox" id="optAllTFs" checked>
            <span class="opt-toggle-label">Include All TFs (1m → 1d)</span>
          </label>
          <label class="opt-toggle-row" title="If base TF result has PF < 1.0, promote the best higher-TF result as recommendation">
            <input type="checkbox" id="optPreferHigherTF" checked>
            <span class="opt-toggle-label">Prefer Higher TF if Lower Fails</span>
          </label>
          <label class="opt-toggle-row" title="If no profitable strategy found after pass 5, run the 8 built-in pivot strategies">
            <input type="checkbox" id="optRunPivots" checked>
            <span class="opt-toggle-label">Run Pivots Fallback (Pass 7)</span>
          </label>
          <label class="opt-toggle-row" title="Apply walk-forward OOS validation on top strategies">
            <input type="checkbox" id="optWalkFwd" checked>
            <span class="opt-toggle-label">Walk-Forward Validation (Pass 4)</span>
          </label>
          <label class="opt-toggle-row" title="Test Signal Quality Score threshold to filter noise">
            <input type="checkbox" id="optSQS" checked>
            <span class="opt-toggle-label">SQS Gate (Pass 5)</span>
          </label>
        </div>

        <!-- Quality thresholds -->
        <div class="opt-section">
          <div class="opt-section-title">Quality Thresholds</div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optMinSQS">Min SQS</label>
            <input type="number" id="optMinSQS" class="opt-input" value="45" min="30" max="70" step="1">
            <span class="opt-field-hint">Signal Quality Score floor (30–70)</span>
          </div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optMinPF">Min PF</label>
            <input type="number" id="optMinPF" class="opt-input" value="1.1" min="1.0" max="5.0" step="0.05">
            <span class="opt-field-hint">Minimum profit factor to qualify</span>
          </div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optTopN">Top N</label>
            <input type="number" id="optTopN" class="opt-input" value="5" min="1" max="20" step="1">
            <span class="opt-field-hint">Number of top strategies to return</span>
          </div>
        </div>

        <!-- Risk / Fee params -->
        <div class="opt-section">
          <div class="opt-section-title">Risk &amp; Fees</div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optRiskPct">Risk % / trade</label>
            <input type="number" id="optRiskPct" class="opt-input" value="1.0" min="0.1" max="10" step="0.1">
          </div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optRRTarget">R:R target</label>
            <input type="number" id="optRRTarget" class="opt-input" value="2.0" min="1.0" max="10" step="0.5">
          </div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optFeePct">Fee RT %</label>
            <input type="number" id="optFeePct" class="opt-input" value="0.65" min="0.0" max="2.0" step="0.05">
            <span class="opt-field-hint">Round-trip fee (entry + exit)</span>
          </div>
          <div class="opt-field-row">
            <label class="opt-field-label" for="optSlippage">Slippage %</label>
            <input type="number" id="optSlippage" class="opt-input" value="0.15" min="0.0" max="1.0" step="0.05">
            <span class="opt-field-hint">Per-side fill slippage estimate</span>
          </div>
        </div>

        <!-- Action buttons -->
        <div class="opt-section opt-actions">
          <button class="btn btn-primary opt-run-btn" id="optRunBtn">
            ⚙ Run Full Optimization
          </button>
          <button class="btn opt-cancel-btn" id="optCancelBtn" disabled>
            ✕ Cancel
          </button>
          <button class="btn opt-quick-btn" id="optQuickScanBtn" title="Quick single-pass scan across all TFs — 5–10× faster than full optimization">
            ⚡ Quick TF Scan
          </button>
        </div>

        <!-- Progress -->
        <div class="opt-progress-wrap" id="optProgressWrap" style="display:none">
          <div class="opt-progress-bar">
            <div class="opt-progress-fill" id="optProgressFill" style="width:0%"></div>
          </div>
          <div class="opt-progress-label" id="optProgressLabel">Starting…</div>
        </div>

      </div><!-- /opt-col-controls -->

      <!-- ── Right column: results ── -->
      <div class="opt-col-results" id="optResultsCol">

        <div class="opt-results-placeholder" id="optResultsPlaceholder">
          <div class="opt-ph-icon">⚙</div>
          <div class="opt-ph-text">Configure &amp; run the optimizer to see results here.</div>
          <div class="opt-ph-hint">Tip: Quick TF Scan gives instant per-TF baseline in ~3 seconds.</div>
        </div>

        <!-- Summary cards (hidden until run completes) -->
        <div id="optResultsContent" style="display:none">

          <!-- Summary bar -->
          <div class="opt-summary-bar" id="optSummaryBar"></div>

          <!-- Alert banners (pivot fallback / promoted TF / all-zero) -->
          <div id="optBanners"></div>

          <!-- Top strategies table -->
          <div class="opt-results-section">
            <div class="opt-results-section-title">Top Strategies</div>
            <div id="optTopTable" class="opt-top-table"></div>
          </div>

          <!-- Multi-TF breakdown table (data from curated results, not raw 1m optimizer) -->
          <div class="opt-results-section" id="optMTFSection" style="display:none">
            <div class="opt-results-section-title">Curated Per-TF Summary <span class="opt-tf-sub" id="optMTFSub"></span></div>
            <div id="optMTFTable"></div>
          </div>

          <!-- Inline strategy preview (shown on row double-click, stays inside modal) -->
          <div class="opt-results-section" id="optStrategyPreview" style="display:none">
            <div class="opt-results-section-title" style="display:flex;justify-content:space-between;align-items:center">
              <span>&#10003; Selected Strategy</span>
              <button class="btn" id="optPreviewClose" style="font-size:10px;padding:2px 8px;line-height:1">&#x2715; Close</button>
            </div>
            <div id="optPreviewBody" class="opt-preview-body"></div>
            <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
              <button class="btn btn-primary" id="optPreviewLoadBtn" style="font-size:11px">&#8617; Load into Signal Editor</button>
              <span style="font-size:10px;color:#4a5580">Strategy is staged — close this panel then open Signal Editor to review.</span>
            </div>
          </div>

          <!-- Export + report actions -->
          <div class="opt-results-actions">
            <button class="btn btn-accent" id="optExportJsonBtn">&#11015; Export JSON</button>
            <button class="btn btn-accent" id="optFullReportBtn">📋 Full Report</button>
            <button class="btn"            id="optSendToEditorBtn">↩ Send Best to Editor</button>
            <button class="btn btn-success" id="optSendToTradingBtn" title="POST best strategy to trading app database">&#11014; Add to Trading App</button>
          </div>

        </div><!-- /optResultsContent -->

        <!-- Quick scan results (separate section) -->
        <div id="optQuickResults" style="display:none">
          <div class="opt-results-section">
            <div class="opt-results-section-title">Quick TF Scan — Baseline</div>
            <div id="optQuickTable"></div>
          </div>
        </div>

      </div><!-- /opt-col-results -->

    </div><!-- /opt-body -->

  </div><!-- /opt-panel-inner -->
</div>
`;

// ─── getCuratedResults ────────────────────────────────────────────────────────
/**
 * Return the quality-gated, PF-sorted curated results from an optimizer run.
 * This is the single authoritative source for all UI display (top table AND
 * multi-TF breakdown).  Raw passStats / topResults are never shown directly.
 *
 * Mirrors the user-requested helper:
 *   curated = optResult.detailed || []   ← preferred if full report was run
 *   fallback to optResult.curatedResults ← from buildCuratedTable (panel-only run)
 */
function getCuratedResults(optResult) {
  // Prefer the full-report `detailed` array (includes all TFs × all strategies).
  // Fall back to the panel's `curatedResults` built by ReportGenerator.buildCuratedTable.
  const raw = optResult?.detailed?.length > 0
    ? optResult.detailed
    : (optResult?.curatedResults ?? []);

  // Gate: exclude 1m entirely (always raw optimizer noise), require ≥3 trades,
  // PF > 0.05 (same as JSON.detailed).  No slice — caller decides row count.
  const filtered = raw
    .filter(r =>
      r.tf !== '1m' &&
      (r.trade_count ?? r.trades ?? 0) >= 3 &&
      (r.pf ?? 0) > 0.05
    )
    .slice() // copy
    .sort((a, b) => b.pf - a.pf);

  // Return up to 20 rows (user-visible curated table). Match JSON.detailed
  // ordering (PF desc) and only apply light gating (PF > 0.05, trades >=3).
  const maxRows = 20;
  if (filtered.length === 0) return [];
  return filtered.slice(0, Math.min(maxRows, filtered.length));
}

// ─── OptimizerPanel class ─────────────────────────────────────────────────────

export class OptimizerPanel {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   */
  constructor(engine) {
    this._engine  = engine;
    this._el      = null;   // root .opt-panel div
    this._mounted = false;
    this._lastResult = null;
    this._seededStrategy = null;

    // Public callback
    this.onRunComplete = null;  // (result) => void
    this.onSendToEditor = null; // (strategy) => void
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  mount() {
    if (this._mounted) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = PANEL_HTML;
    this._el = wrap.firstElementChild;
    document.body.appendChild(this._el);
    this._mounted = true;
    this._bindEvents();
  }

  unmount() {
    this._el?.remove();
    this._mounted = false;
  }

  show() {
    if (!this._mounted) this.mount();
    this._el.hidden = false;
    this._syncContext();
    // Trap Esc key for close
    this._escHandler = (e) => { if (e.key === 'Escape') this.hide(); };
    document.addEventListener('keydown', this._escHandler);
  }

  hide() {
    if (!this._mounted || this._el.hidden) return;
    this._el.hidden = true;
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  }

  toggle() {
    this.isVisible ? this.hide() : this.show();
  }

  get isVisible() { return this._mounted && !this._el?.hidden; }

  /**
   * Pre-fill the optimizer with a strategy from SignalRuleEditor.
   * Shows the "Seeded" badge so the user knows where it came from.
   * @param {object} strategy
   */
  loadStrategy(strategy) {
    this._seededStrategy = strategy;
    if (!this._mounted) this.mount();
    const badge = this._el.querySelector('#optSeedInfo');
    if (badge) badge.style.display = '';
    // Merge fee/risk from strategy if available
    if (strategy?.fees) {
      const rt = ((strategy.fees.entry_pct ?? 0) + (strategy.fees.exit_pct ?? 0)).toFixed(2);
      this._setVal('optFeePct', rt);
    }
    if (strategy?.risk?.risk_per_trade_pct) {
      this._setVal('optRiskPct', strategy.risk.risk_per_trade_pct);
    }
    if (strategy?.exit?.take_profit?.ratio) {
      this._setVal('optRRTarget', strategy.exit.take_profit.ratio);
    }
  }

  // ─── Event wiring ───────────────────────────────────────────────────────

  _bindEvents() {
    const el = this._el;

    el.querySelector('#optCloseBtn')?.addEventListener('click', () => this.hide());

    el.querySelector('#optRunBtn')?.addEventListener('click', () => this._runOptimizer());
    el.querySelector('#optCancelBtn')?.addEventListener('click', () => this._cancel());
    el.querySelector('#optQuickScanBtn')?.addEventListener('click', () => this._runQuickScan());

    el.querySelector('#optExportJsonBtn')?.addEventListener('click', () => this._exportJson());
    el.querySelector('#optFullReportBtn')?.addEventListener('click', () => this._runFullReport());
    el.querySelector('#optSendToEditorBtn')?.addEventListener('click', () => this._sendBestToEditor());
    el.querySelector('#optSendToTradingBtn')?.addEventListener('click', () => this._sendToTradingApp());

    // Click on backdrop (outside inner panel) closes
    el.addEventListener('click', (e) => {
      if (e.target === el) this.hide();
    });
  }

  // ─── Context sync ────────────────────────────────────────────────────────

  _syncContext() {
    const e    = this._engine;
    const sym  = e?.state?.symbol   ?? e?.state?._symbol   ?? '–';
    const tf   = e?.state?.timeframe ?? e?.state?._timeframe ?? '–';
    const bars = (e?.data?._all?.bars ?? e?.state?.bars ?? []);
    const spanDays = bars.length > 1
      ? ((bars[bars.length-1].t - bars[0].t) / 86_400_000).toFixed(1) + 'd'
      : '–';
    this._setText('optCtxSymbol', sym);
    this._setText('optCtxTF',     tf);
    this._setText('optCtxBars',   `${bars.length.toLocaleString()} (${spanDays})`);
  }

  // ─── Optimizer run ───────────────────────────────────────────────────────

  _collectOpts() {
    return {
      historyDays:   +this._val('optHistoryDays'),
      allTfs:         this._checked('optAllTFs'),
      preferHigherTF: this._checked('optPreferHigherTF'),
      runPivots:      this._checked('optRunPivots'),
      walkFwd:        this._checked('optWalkFwd'),
      sqsGate:        this._checked('optSQS'),
      minSQS:        +this._val('optMinSQS'),
      minPF:         +this._val('optMinPF'),
      topN:          +this._val('optTopN'),
      riskPct:       +this._val('optRiskPct'),
      rrTarget:      +this._val('optRRTarget'),
      feePct:        +this._val('optFeePct'),
      slippage:      +this._val('optSlippage'),
    };
  }

  async _runOptimizer() {
    const engine = this._engine;
    if (!engine) { this._setHeaderSub('No engine attached'); return; }

    const strategy = this._seededStrategy ?? engine.signalEditor?.strategy ?? engine.state?.strategy;
    if (!strategy) { this._setHeaderSub('⚠ No strategy — open Signal Editor first'); return; }

    const opts    = this._collectOpts();
    const symbol  = engine.state?.symbol;

    this._setRunning(true);
    this._showProgress(true);
    this._setHeaderSub(`Preparing ${symbol ?? ''}…`);
    this._hideResults();
    this._el.querySelector('#optQuickResults').style.display = 'none';

    // ── Fetch fresh history if panel selector wants more than what's loaded ──
    let bars = engine.data?._all?.bars ?? engine.state?.bars ?? [];

    if (opts.historyDays > 0 && symbol) {
      const loadedDays = bars.length > 1
        ? (bars[bars.length - 1].t - bars[0].t) / 86_400_000
        : 0;

      // Only re-fetch if loaded span is materially shorter than requested
      if (loadedDays < opts.historyDays * 0.9) {
        let fetchDone = 0, fetchTotal = 1;
        const progressCb = (done, total) => {
          fetchDone  = done;
          fetchTotal = total;
          const pct  = total > 0 ? done / total : 0;
          this._setProgress(pct * 0.4,   // first 40% of bar = fetch
            `Fetching ${opts.historyDays}d history… ${done}/${total} windows`);
        };

        try {
          this._setProgress(0, `Fetching ${opts.historyDays}d of ${symbol} history…`);
          const data = await makeOptimizerProvider(symbol, {
            daysBack:   opts.historyDays,
            progressCb,
          })();
          bars = data.bars;
          this._setText('optCtxBars', bars.length.toLocaleString());
          this._setProgress(0.4, `Fetched ${bars.length.toLocaleString()} bars — starting optimizer…`);
        } catch (err) {
          console.warn('[OptimizerPanel] history fetch failed, using loaded bars:', err.message);
          this._setProgress(0, `Fetch failed — using ${bars.length.toLocaleString()} loaded bars`);
          bars = engine.data?._all?.bars ?? engine.state?.bars ?? [];
        }
      }
    }

    if (!bars?.length) {
      this._setHeaderSub('⚠ No bars available — load a symbol first');
      this._setRunning(false);
      this._showProgress(false);
      return;
    }

    this._setHeaderSub(`Optimizing ${symbol ?? ''} @ ${engine.state?.timeframe ?? ''}…`);

    // Wrap progressCb so optimizer steps occupy the remaining 60% of the bar
    const baseOpts = { ...opts };
    const origPCb  = baseOpts.progressCb;
    baseOpts.progressCb = (info) => {
      const pct = typeof info?.pct === 'number' ? info.pct : 0;
      this._setProgress(0.4 + pct * 0.6, info?.label ?? '');
      origPCb?.(info);
    };

    try {
      const result = await engine.runOptimizer(bars, strategy, baseOpts);
      if (!result) {
        this._setHeaderSub('Cancelled');
        this._setRunning(false);
        this._showProgress(false);
        return;
      }

      // ── Build curated cross-TF results for the panel table ─────────────
      // topResults = raw 1m combos (thousands of trades, garbage WR).
      // curatedResults = top 3 strategies re-backtested on every TF
      // using resampled bars — same data as the JSON report's `detailed` array.
      console.log('[OptimizerPanel] Raw topResults count:', result.topResults?.length,
        'top PF:', result.topResults?.[0]?.stats?.profit_factor);
      this._setHeaderSub('Building curated cross-TF results…');
      try {
        const baseTF = engine.state?.timeframe ?? '1m';
        result.curatedResults = await ReportGenerator.buildCuratedTable(bars, result, {
          topN:   Math.max(10, opts.topN ?? 5),  // test at least 10 from optimizer pool
          baseTF,
        });
        console.log('[OptimizerPanel] Curated results count:', result.curatedResults?.length);
      } catch (curErr) {
        console.warn('[OptimizerPanel] buildCuratedTable error — falling back to topResults:', curErr);
        result.curatedResults = null;
      }

      this._lastResult = result;
      this._renderResults(result, opts);
      this._setHeaderSub(`Done — ${result.passStats?.totalCombos ?? '?'} combos · ${result.passStats?.elapsedMs ?? '?'}ms`);
      if (typeof this.onRunComplete === 'function') this.onRunComplete(result);
    } catch (err) {
      console.error('[OptimizerPanel]', err);
      this._setHeaderSub(`Error: ${err.message}`);
    } finally {
      this._setRunning(false);
      this._showProgress(false);
    }
  }

  _cancel() {
    this._engine?.cancelOptimizer?.();
    this._setRunning(false);
    this._showProgress(false);
    this._setHeaderSub('Cancelled');
  }

  async _runQuickScan() {
    const engine   = this._engine;
    const strategy = this._seededStrategy ?? engine?.signalEditor?.strategy;
    if (!strategy) { this._setHeaderSub('⚠ Need a strategy for quick scan'); return; }

    const symbol       = engine?.state?.symbol;
    const historyDays  = +this._val('optHistoryDays');
    let   bars         = engine?.data?._all?.bars ?? engine?.state?.bars ?? [];

    if (historyDays > 0 && symbol) {
      const loadedDays = bars.length > 1
        ? (bars[bars.length - 1].t - bars[0].t) / 86_400_000
        : 0;
      if (loadedDays < historyDays * 0.9) {
        this._setHeaderSub(`Fetching ${historyDays}d history…`);
        try {
          const data = await makeOptimizerProvider(symbol, { daysBack: historyDays })();
          bars = data.bars;
          this._setText('optCtxBars', bars.length.toLocaleString());
        } catch (err) {
          console.warn('[OptimizerPanel] quick scan fetch failed:', err.message);
        }
      }
    }

    if (!bars?.length) { this._setHeaderSub('⚠ No bars available — load a symbol first'); return; }

    this._setHeaderSub('Running quick TF scan…');
    this._el.querySelector('#optQuickResults').style.display = 'none';

    try {
      const tfs = await engine.quickScanAllTFs?.(bars, strategy);
      if (tfs) this._renderQuickTable(tfs);
    } catch (err) {
      this._setHeaderSub(`Quick scan error: ${err.message}`);
    }
  }

  // ─── Results rendering ───────────────────────────────────────────────────

  /**
   * Silently load a strategy into the Signal Editor without showing/focusing it.
   * The user stays inside the optimizer modal; they close it when ready to inspect.
   */
  _loadStrategyIntoEditor(strategy, tf) {
    const editor = this._engine?.signalEditor;
    if (!editor || !strategy) return;
    editor.strategy = strategy;
    if (typeof editor._refresh === 'function') editor._refresh();
    // Intentionally do NOT call editor.show() — that raises the SRE overlay,
    // which appears as a "new window" since both panels are full-screen overlays.
    this._engine?.setStatus?.(`${tf ?? ''} strategy staged — close optimizer to view in Signal Editor`);
  }

  /**
   * Populate and show the inline strategy preview card inside the panel.
   * No new window, no panel switch — stays in the optimizer overlay.
   */
  _showStrategyPreview(data) {
    const preview = this._el.querySelector('#optStrategyPreview');
    const body    = this._el.querySelector('#optPreviewBody');
    if (!preview || !body) return;

    const pfN    = data.pf ?? 0;
    const pfCls  = pfN >= 1.5 ? 'opt-pf-hi' : pfN >= 1.1 ? 'opt-pf-ok' : pfN < 1.0 ? 'opt-pf-lo' : '';
    // Build a rich readable description from condition labels (pivot strategies have
    // full labels like "Close > Daily R1 (classic pivot)"; optimizer strategies use id).
    const stratEntry = data.strategy?.entry;
    const activeConds = (stratEntry?.conditions ?? data.conditions?.map(id => ({ id, label: id })) ?? [])
      .filter(c => c.enabled !== false);
    const logic  = stratEntry?.logic ?? 'AND';
    const condLabels = activeConds.map(c =>
      c.label && c.label !== c.id ? c.label : c.id
    );
    const conds  = condLabels.join(` ${logic} `) || data.strategy_name || '–';
    const name   = data.strategy?.meta?.name ?? data.strategy_name ?? condLabels.join(' + ') ?? '–';
    const netNum = typeof data.net_pnl_usd === 'number' ? data.net_pnl_usd : null;
    const netStr = netNum != null ? `${netNum >= 0 ? '+' : ''}${netNum.toFixed(2)}` : '–';
    const netCls = netNum != null && netNum > 0 ? 'opt-pf-ok' : netNum != null && netNum < 0 ? 'opt-pf-lo' : '';
    const pivTag = data.is_pivot ? ' <span class="opt-badge opt-badge-dim">Pivot</span>' : '';

    body.innerHTML = `
      <div class="opt-preview-grid">
        <div class="opt-preview-item opt-preview-wide">
          <span class="opt-preview-key">Name</span>
          <span class="opt-preview-val">${name}${pivTag}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">TF</span>
          <span class="opt-preview-val">${data.tf ?? '–'}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">Direction</span>
          <span class="opt-preview-val ${data.dir === 'long' ? 'opt-td-long' : 'opt-td-short'}">${data.dir ?? '?'}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">PF</span>
          <span class="opt-preview-val ${pfCls}">${pfN.toFixed(3)}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">Win Rate</span>
          <span class="opt-preview-val">${typeof data.win_rate === 'number' ? data.win_rate.toFixed(1) : (data.win_rate ?? '–')}%</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">Trades</span>
          <span class="opt-preview-val">${data.trade_count ?? '–'}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">Avg R</span>
          <span class="opt-preview-val">${typeof data.avg_rr === 'number' ? data.avg_rr.toFixed(2) : '–'}</span>
        </div>
        <div class="opt-preview-item">
          <span class="opt-preview-key">Net P&amp;L</span>
          <span class="opt-preview-val ${netCls}">${netStr}</span>
        </div>
        <div class="opt-preview-item opt-preview-wide">
          <span class="opt-preview-key">Conditions (${logic})</span>
          <span class="opt-preview-val" style="word-break:break-word">${conds}</span>
        </div>
      </div>`;

    // Highlight the selected row
    this._previewData = data;
    preview.style.display = '';
    preview.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });

    // Close button
    const closeBtn = this._el.querySelector('#optPreviewClose');
    if (closeBtn) {
      const handler = () => { preview.style.display = 'none'; };
      closeBtn.replaceWith(closeBtn.cloneNode(true));   // remove old listeners
      this._el.querySelector('#optPreviewClose').addEventListener('click', handler);
    }

    // Load button — loads silently, no editor.show()
    const loadBtn = this._el.querySelector('#optPreviewLoadBtn');
    if (loadBtn) {
      const handler = () => {
        this._loadStrategyIntoEditor(data.strategy, data.tf);
        loadBtn.textContent = '✓ Staged — close panel to view';
        loadBtn.disabled = true;
        setTimeout(() => { loadBtn.textContent = '↩ Load into Signal Editor'; loadBtn.disabled = false; }, 3000);
      };
      loadBtn.replaceWith(loadBtn.cloneNode(true));
      this._el.querySelector('#optPreviewLoadBtn').addEventListener('click', handler);
    }
  }

  _renderResults(result, opts) {
    const ps  = result.passStats;
    const top = result.topResults[0];

    // ── Summary bar — prefer best curated PF over raw optimizer PF ──────────
    // raw topResults[0].stats = 1m optimizer combo (3000+ trades, bad WR)
    // curatedResults[0]       = best result re-backtested on resampled bars (real PF)
    const curatedBest = result.curatedResults?.[0];  // sorted by PF desc in buildCuratedTable
    const pf     = (curatedBest?.pf ?? top?.stats?.profit_factor)?.toFixed?.(3) ?? '–';
    const wr     = curatedBest
      ? (typeof curatedBest.win_rate === 'number' ? curatedBest.win_rate.toFixed(1) : curatedBest.win_rate) ?? '–'
      : (top?.stats?.win_rate ?? '–');
    const trades = curatedBest?.trade_count ?? top?.stats?.total ?? '–';
    const pfSrc  = curatedBest ? ` <span class="opt-badge opt-badge-dim" title="Curated: ${curatedBest.tf} ${curatedBest.strategy_name}">${curatedBest.tf}</span>` : '';
    const oosC   = ps.oosValidCount > 0 ? `<span class="opt-badge opt-badge-ok">✓ ${ps.oosValidCount} OOS-valid</span>` : '';
    const sqs    = ps.recommendedMinSQS > 0 ? `<span class="opt-badge opt-badge-dim">SQS≥${ps.recommendedMinSQS}</span>` : '';
    const prof   = ps.foundProfitable
      ? `<span class="opt-badge opt-badge-ok">✓ Profitable found</span>`
      : `<span class="opt-badge opt-badge-warn">⚠ No profitable — best-of-rest shown</span>`;
    const elapsed = ps.elapsedMs ?? '?';
    this._setHTML('optSummaryBar', `
      <div class="opt-summ-stat"><span class="opt-summ-val">${pf}</span><span class="opt-summ-key">Best PF${pfSrc}</span></div>
      <div class="opt-summ-stat"><span class="opt-summ-val">${wr}%</span><span class="opt-summ-key">Win Rate</span></div>
      <div class="opt-summ-stat"><span class="opt-summ-val">${trades}</span><span class="opt-summ-key">Trades</span></div>
      <div class="opt-summ-stat"><span class="opt-summ-val">${elapsed}ms</span><span class="opt-summ-key">Elapsed</span></div>
      <div class="opt-summ-badges">${prof}${oosC}${sqs}</div>
    `);

    // ── Banners ───────────────────────────────────────────────────────────
    const banners = [];
    if (ps.usedFallback)
      banners.push(`<div class="opt-banner opt-banner-warn">⚠ All strategy combos below threshold — showing best-of-worst. Try more bars or OR logic.</div>`);

    if (ps.promotedToHigherTF) {
      const toTF   = ps.promotedToTF   ?? ps.multiTFStats?.best_higher_tf?.tf  ?? '?';
      const toPF   = ps.promotedToPF   ?? ps.multiTFStats?.best_higher_tf?.pf  ?? '?';
      const frPF   = typeof ps.promotedFromPF === 'number' ? ps.promotedFromPF.toFixed(3) : (ps.promotedFromPF ?? '?');
      const frTF   = ps.promotedFromTF ?? '?';
      const bestName = result.topResults[0]?.strategy?.meta?.name ?? result.topResults[0]?.strategy?.name ?? '';
      const label    = bestName ? ` — "${bestName.slice(0, 32)}"` : '';
      banners.push(`
        <div class="opt-banner opt-banner-green">
          📈 <strong>Recommended: Switch to ${toTF}</strong> (PF ${toPF}${label})
          <br><small style="opacity:.75">Base TF ${frTF} PF was ${frPF} — ${toTF} shows a clear edge. Tip: 1h often best balance of signal quality &amp; fee resistance.</small>
        </div>`);
    }
    if (ps.multiTFStats?.all_zero)
      banners.push(`<div class="opt-banner opt-banner-err">⚠ Optimizer multi-TF scan: all TFs returned 0 trades on the raw 1m combo. Curated results shown below are from resampled bars.</div>`);
    if (ps.pivotsTested > 0 && !ps.foundProfitable)
      banners.push(`<div class="opt-banner opt-banner-blue">🔄 Pivot fallback tested ${ps.pivotsTested} pivot strategies.</div>`);
    this._setHTML('optBanners', banners.join(''));

    // ── Top strategies table — curated cross-TF results ────────────────
    // getCuratedResults() is the single truth source for all display.
    // Raw topResults (1m combos, 3000+ trades, 4.5% WR) are never shown.
    const tableEl      = this._el.querySelector('#optTopTable');
    const tableData    = getCuratedResults(result);
    const usingCurated = tableData.length > 0;

    // Fallback: if curation produced nothing, wrap raw topResults minimally
        const displayData = usingCurated
          ? tableData
          : (result.topResults ?? []).slice(0, 10).map((r, i) => ({
              rank:          i,
              tf:            '1m',
              dir:           r.strategy?.entry?.direction ?? '?',
              conditions:    (r.strategy?.entry?.conditions ?? []).filter(c => c.enabled !== false).map(c => c.id),
              pf:            r.stats?.profit_factor ?? 0,
              win_rate:      r.stats?.win_rate ?? 0,
              trade_count:   r.stats?.total ?? 0,
              avg_rr:        r.stats?.avg_rr ?? 0,
              net_pnl_usd:   r.stats?.net_pnl_usd ?? 0,
              strategy:      r.strategy,
              strategy_name: r.strategy?.meta?.name ?? r.strategy?.name ?? 'Unnamed',
              is_pivot:      r.is_pivot ?? false,
            }));
    // Apply a small diversity bias so strategies using VWAP/volume/ATR/BB/regime
    // get a slight boost in ordering when PFs are near-equal. This helps
    // surface structurally diverse strategies into the 5-15 curated rows.
        const diversityIds = new Set(['price_above_vwap','price_below_vwap','volume_spike','atr_breakout','vol_expansion','bb_squeeze','regime_is','adx_above','ema_above_slow']);
        const biased = (displayData || []).slice().map(d => {
          const conds = (d.conditions ?? []).slice(0, 12);
          const divCnt = conds.filter(c => diversityIds.has(c)).length;
          const multBias = 1 + Math.min(0.30, 0.06 * divCnt); // multiplicative up to +30%
          const addBonus = divCnt >= 2 ? 0.2 : 0.0; // additive PF boost
          const basePf = (d.pf ?? 0) || 0;
          const score = basePf * multBias + addBonus;
          return { _base: d, _score: score, _divCnt: divCnt };
        }).sort((a, b) => b._score - a._score).map(x => x._base);

    console.log('[OptimizerPanel._renderResults] tableData source:', usingCurated ? 'CURATED' : 'RAW topResults (fallback)', 'count:', biased.length);
    // User-requested diagnostics — confirm table is using curated, not raw data
    console.log('Table data source length:', displayData?.length);
    console.log('Is this curated? First row:', displayData?.[0]);

    const rows = biased.map((r, i) => {
      const pfN   = r.pf ?? 0;
      const pfVal = pfN ? pfN.toFixed(3) : '–';
      const pfCls = pfN >= 1.5 ? ' opt-pf-hi' : pfN >= 1.1 ? ' opt-pf-ok' : pfN > 0 && pfN < 1.0 ? ' opt-pf-lo' : '';
      // Prefer the descriptive strategy_name (built from meta.name by _buildStrategyName)
      // over raw condition IDs — gives readable "VWAP↑ + vol×1.8 + regime🐂" labels.
      const rawIdsArr = (r.conditions ?? []);
      const rawIds  = rawIdsArr.join(' + ');
      // Prefer meaningful meta names; but if the name looks generic (MOCK/Unnamed)
      // fallback to a constructed label from condition labels.
      let dispName = r.strategy_name ?? '';
      if (!dispName || /mock|unnamed|optimized/i.test(dispName)) {
        // build human-friendly labels from the condition ids
        const friendly = rawIdsArr.map(id => {
          switch (id) {
            case 'price_above_vwap': return 'VWAP↑';
            case 'price_below_vwap': return 'VWAP↓';
            case 'volume_spike': return 'vol×';
            case 'ema_above_slow': return 'EMA↑';
            case 'ema_below_slow': return 'EMA↓';
            case 'atr_breakout': return 'ATR↑';
            case 'vol_expansion': return 'volExp';
            case 'bb_squeeze': return 'BB_sqz';
            case 'regime_is': return 'regime';
            default: return id;
          }
        }).slice(0,6);
        dispName = friendly.join(' + ');
      }
      // Show the full condition-ID list as a tooltip for debugging
      const titleTip = rawIds && rawIds !== dispName ? `${dispName} | conds: ${rawIds}` : dispName;
      const pivBadge = r.is_pivot
        ? ' <span class="opt-badge opt-badge-dim" title="Pivot strategy">P</span>' : '';
      const rowCls = i === 0 ? ' opt-row-best' : '';
      const dirCls = r.dir === 'long' ? 'opt-td-long' : 'opt-td-short';
      const wr     = typeof r.win_rate === 'number' ? r.win_rate.toFixed(1) : (r.win_rate ?? '–');
      const rr     = typeof r.avg_rr   === 'number' ? r.avg_rr.toFixed(2)   : '–';
      const netUSD = typeof r.net_pnl_usd === 'number' ? (r.net_pnl_usd >= 0 ? '+' : '') + r.net_pnl_usd.toFixed(0) : '–';
      const netCls = typeof r.net_pnl_usd === 'number' && r.net_pnl_usd > 0 ? ' opt-pf-ok' : typeof r.net_pnl_usd === 'number' && r.net_pnl_usd < 0 ? ' opt-pf-lo' : '';
      return `<tr class="opt-tr${rowCls}" data-idx="${i}" style="cursor:pointer" title="Double-click to preview — ${titleTip}">
        <td class="opt-td opt-td-rank">${i + 1}</td>
        <td class="opt-td opt-td-tf">${r.tf ?? '–'}${pivBadge}</td>
        <td class="opt-td opt-td-dir ${dirCls}">${r.dir ?? '?'}</td>
        <td class="opt-td opt-td-conds" title="${titleTip}">${dispName}</td>
        <td class="opt-td opt-td-num${pfCls}">${pfVal}</td>
        <td class="opt-td opt-td-num">${wr}%</td>
        <td class="opt-td opt-td-num">${r.trade_count ?? '–'}</td>
        <td class="opt-td opt-td-rr">${rr}</td>
        <td class="opt-td opt-td-num${netCls}">${netUSD}</td>
      </tr>`;
    }).join('');

    if (tableEl) {
      tableEl.innerHTML = `
        <table class="opt-table">
          <thead><tr>
            <th class="opt-th">#</th>
            <th class="opt-th">TF</th>
            <th class="opt-th">Dir</th>
            <th class="opt-th">Strategy / Conditions</th>
            <th class="opt-th">PF</th>
            <th class="opt-th">WR</th>
            <th class="opt-th">Trades</th>
            <th class="opt-th">Avg R</th>
            <th class="opt-th">Net $</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:4px;font-size:10px;color:#4a5580">
          ${usingCurated
            ? `Curated high-quality results after gating &amp; pivots — raw noise excluded`
            : `&#9888; Curated results unavailable — showing raw 1m optimizer combos.`}
          &nbsp;&#8595; Double-click a row for preview &amp; staging.
        </div>
      `;
      tableEl.querySelectorAll('tr[data-idx]').forEach(row => {
        row.addEventListener('dblclick', () => {
          const idx  = +row.dataset.idx;
          const data = displayData[idx];
          if (!data) return;
          // Highlight selected row
          tableEl.querySelectorAll('tr[data-idx]').forEach(r => r.style.outline = '');
          row.style.outline = '2px solid #4ade80';
          // Immediately stage strategy in Signal Editor — no editor.show(), no new window.
          // The strategy is loaded silently; the user stays inside the optimizer modal.
          this._loadStrategyIntoEditor(data.strategy, data.tf);
          // Show inline preview card for review — still inside the optimizer overlay.
          this._showStrategyPreview(data);
          this._setHeaderSub(`\u2713 ${data.tf ?? ''} strategy staged \u2014 close panel to view in Signal Editor`);
        });
      });
    }

    // ── Multi-TF per-TF breakdown — CURATED data only ────────────────────
    // Build per-TF summary entirely from curatedResults (same source as the
    // top table).  The raw ps.multiTFStats is intentionally NOT used here
    // because it reflects the best 1m combo tested on each TF — exactly the
    // "3454 trades 4.5% WR" raw noise we want to suppress.
    //
    // Aggregate: for each TF keep the best-PF curated entry as representative.
    const mtfSec = this._el.querySelector('#optMTFSection');
    const curatedForMTF = getCuratedResults(result);   // quality-gated, sorted desc PF

    if (curatedForMTF.length && mtfSec) {
      // Group by TF — accumulate best PF and all entries for avg
      const tfMap = new Map();  // tf → best curated entry
      for (const r of curatedForMTF) {
        const prev = tfMap.get(r.tf);
        if (!prev || r.pf > prev.pf) tfMap.set(r.tf, r);
      }

      // Sort TFs by canonical order (5m first — 1m already excluded upstream)
      const TF_ORDER = ['5m','15m','30m','1h','2h','4h','8h','1d'];
      const tfEntries = [...tfMap.entries()]
        .filter(([tf]) => tf !== '1m')          // belt-and-suspenders: never include 1m
        .sort((a, b) => {
          const ai = TF_ORDER.indexOf(a[0]), bi = TF_ORDER.indexOf(b[0]);
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });

      // Weighted-avg PF (weight = trade_count) — 1m already filtered above
      let wSum = 0, wCnt = 0;
      for (const [tf, e] of tfEntries) {
        if (tf === '1m') continue;              // redundant guard, never triggers
        const tc = e.trade_count ?? 0;
        wSum += (e.pf ?? 0) * tc;
        wCnt += tc;
      }
      const wavgPF = wCnt > 0 ? (wSum / wCnt).toFixed(3) : '–';

      mtfSec.style.display = '';
      const sub = `curated · weighted avg PF ${wavgPF} · ${tfEntries.length} TF${tfEntries.length !== 1 ? 's' : ''} with qualifying results`;
      this._setText('optMTFSub', sub);

      const promoTF = ps.promotedToTF;
      const tfRows = tfEntries.map(([tf, e]) => {
        const pfN   = e.pf ?? 0;
        const pfS   = pfN.toFixed(3);
        const pfCls = pfN >= 1.5 ? ' opt-pf-hi' : pfN >= 1.1 ? ' opt-pf-ok' : pfN < 1.0 ? ' opt-pf-lo' : '';
        const rowCls= pfN >= 1.1 ? ' opt-tf-good' : '';
        const star  = tf === promoTF ? ' 🏆' : '';
        const pivBadge = e.is_pivot
          ? ' <span class="opt-badge opt-badge-dim" style="font-size:9px">P</span>' : '';
        const wr   = typeof e.win_rate    === 'number' ? e.win_rate.toFixed(1)    : (e.win_rate ?? '–');
        const rr   = typeof e.avg_rr      === 'number' ? e.avg_rr.toFixed(2)      : '–';
        const name = (e.strategy?.meta?.name ?? e.strategy_name ?? '').slice(0, 28);
        return `<tr class="opt-tr${rowCls}" title="${name}">
          <td class="opt-td opt-td-tf">${tf}${star}${pivBadge}</td>
          <td class="opt-td opt-td-num${pfCls}">${pfS}</td>
          <td class="opt-td opt-td-num">${wr}%</td>
          <td class="opt-td opt-td-num">${e.trade_count ?? '–'}</td>
          <td class="opt-td opt-td-rr">${rr}</td>
        </tr>`;
      }).join('');

      this._setHTML('optMTFTable', `
        <table class="opt-table">
          <thead><tr>
            <th class="opt-th">TF</th><th class="opt-th">PF</th>
            <th class="opt-th">WR</th><th class="opt-th">Trades</th><th class="opt-th">Avg R</th>
          </tr></thead>
          <tbody>${tfRows}</tbody>
        </table>
        <div style="margin-top:4px;font-size:10px;color:#4a5580">
          Best curated strategy per TF — pivot (P) and optimizer results combined.&nbsp;
          <span style="color:#4ade80">█</span> PF≥1.5&nbsp;
          <span style="color:#86e07f">█</span> PF≥1.1&nbsp;
          <span style="color:#f87171">█</span> PF&lt;1.0&nbsp;
          🏆&nbsp;recommended TF
        </div>
      `);
    } else if (mtfSec) {
      // No curated data — hide the section rather than show raw noise
      mtfSec.style.display = 'none';
    }

    this._el.querySelector('#optResultsPlaceholder').style.display = 'none';
    this._el.querySelector('#optResultsContent').style.display = '';
  }

  _renderQuickTable(tfs) {
    const rows = tfs.map(t => {
      const ok  = t.trades > 0;
      const pf  = ok ? (t.stats?.profit_factor?.toFixed(3) ?? '?') : '–';
      const wr  = ok ? (t.stats?.win_rate ?? '?') + '%' : '–';
      const cls = ok ? '' : ' opt-tf-zero';
      return `<tr class="opt-tr${cls}">
        <td class="opt-td opt-td-tf">${t.tf}</td>
        <td class="opt-td opt-td-num">${pf}</td>
        <td class="opt-td opt-td-num">${wr}</td>
        <td class="opt-td opt-td-num">${t.trades}</td>
        <td class="opt-td opt-td-bars">${t.bars}</td>
      </tr>`;
    }).join('');
    this._setHTML('optQuickTable', `
      <table class="opt-table">
        <thead><tr>
          <th class="opt-th">TF</th><th class="opt-th">PF</th>
          <th class="opt-th">WR</th><th class="opt-th">Trades</th><th class="opt-th">Bars (resampled)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `);
    this._el.querySelector('#optQuickResults').style.display = '';
  }

  _hideResults() {
    this._el.querySelector('#optResultsPlaceholder').style.display = '';
    this._el.querySelector('#optResultsContent').style.display = 'none';
  }

  // ─── Export helpers ──────────────────────────────────────────────────────

  _exportJson() {
    if (!this._lastResult) return;
    const sym  = this._engine?.state?.symbol ?? 'unknown';
    const tf   = this._engine?.state?.timeframe ?? '';
    // Prefer exporting the curated/detailed results (best for ensemble voters).
    const curated = this._lastResult.detailed && this._lastResult.detailed.length > 0
      ? this._lastResult.detailed
      : (this._lastResult.curatedResults ?? []);

    const exportPayload = {
      exported_at: new Date().toISOString(),
      symbol: sym,
      base_tf: tf,
      passStats: this._lastResult.passStats,
      curated: curated.map(c => ({
        tf: c.tf,
        pf: c.pf,
        win_rate: c.win_rate,
        trade_count: c.trade_count,
        avg_rr: c.avg_rr,
        strategy_name: c.strategy_name,
        strategy: c.strategy,           // full strategy JSON
        backtest_summary: {
          net_pnl_usd: c.net_pnl_usd,
        }
      })),
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), {
      href: url, download: `opt_${sym.replace('/', '')}_${tf}_${Date.now()}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  async _runFullReport() {
    if (!this._lastResult) {
      this._setHeaderSub('Run optimizer first to generate a full report');
      return;
    }
    const engine = this._engine;
    const bars    = engine?.data?._all?.bars ?? engine?.state?.bars;
    const strategy = this._lastResult.best ?? this._seededStrategy ?? engine?.signalEditor?.strategy;
    if (!bars?.length || !strategy) return;

    this._setHeaderSub('Generating full report…');
    this._showProgress(true);
    this._setProgress(0, 'Preparing report…');
    try {
      await engine.generateOptimizerReport?.(this._lastResult, { bars, strategy });
      // Progress bar cleared by Engine after completion
    } catch (err) {
      this._setHeaderSub(`Report error: ${err.message}`);
      this._showProgress(false);
    }
  }

  _sendBestToEditor() {
    const best = this._lastResult?.best;
    if (!best) return;
    if (typeof this.onSendToEditor === 'function') {
      this.onSendToEditor(best);
      this.hide();
    } else {
      this._engine?.receiveStrategyFromOptimizer?.(best);
      this.hide();
    }
  }

  async _sendToTradingApp() {
    const best  = this._lastResult?.best;
    const stats = this._lastResult?.topResults?.[0]?.stats ?? null;
    if (!best) {
      this._setHeaderSub('⚠ No result available — run optimizer first');
      return;
    }
    const btn = this._el?.querySelector('#optSendToTradingBtn');
    if (btn) btn.disabled = true;
    this._setHeaderSub('Exporting to trading app…');
    try {
      if (typeof this._engine?._sendStrategyToTradingApp === 'function') {
        await this._engine._sendStrategyToTradingApp(best, stats);
        this._setHeaderSub('✓ Strategy added to trading app');
      } else {
        this._setHeaderSub('⚠ Engine export method not found');
      }
    } catch (err) {
      this._setHeaderSub(`Export failed: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ─── Progress ────────────────────────────────────────────────────────────

  /** @param {{ phase, pct, label, detail }} info */
  updateProgress({ phase, pct, label, detail }) {
    this._setProgress(pct, `${label}${detail ? ` · ${detail}` : ''}`);
  }

  _setProgress(pct, label) {
    const fill = this._el?.querySelector('#optProgressFill');
    if (fill) fill.style.width = pct >= 0 ? `${Math.min(pct, 100)}%` : '0%';
    fill?.classList.toggle('indeterminate', pct < 0);
    this._setText('optProgressLabel', label ?? '');
  }

  _showProgress(visible) {
    const wrap = this._el?.querySelector('#optProgressWrap');
    if (wrap) wrap.style.display = visible ? '' : 'none';
  }

  _setRunning(running) {
    const run    = this._el?.querySelector('#optRunBtn');
    const cancel = this._el?.querySelector('#optCancelBtn');
    const quick  = this._el?.querySelector('#optQuickScanBtn');
    if (run)    { run.disabled = running;    run.textContent = running ? '⚙ Optimizing…' : '⚙ Run Full Optimization'; }
    if (cancel) { cancel.disabled = !running; }
    if (quick)  { quick.disabled  = running; }
  }

  // ─── DOM helpers ─────────────────────────────────────────────────────────

  _el$  = (id) => this._el?.querySelector(`#${id}`);
  _val  = (id) => this._el$(id)?.value ?? '';
  _setVal = (id, v) => { const el = this._el$(id); if (el) el.value = v; };
  _checked = (id) => this._el$(id)?.checked ?? false;
  _setText = (id, t) => { const el = this._el$(id); if (el) el.textContent = t; };
  _setHTML = (id, h) => { const el = this._el$(id); if (el) el.innerHTML = h; };
  _setHeaderSub = (t) => this._setText('optHeaderSub', t);
}
