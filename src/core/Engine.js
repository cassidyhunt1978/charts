import { createState } from "./State.js";
import { DataEngine } from "../data/DataEngine.js";
import { LayoutEngine } from "../layout/LayoutEngine.js";
import { Renderer } from "../render/Renderer.js";
import { InteractionEngine } from "../interaction/InteractionEngine.js";
import { ReplayController } from "../replay/ReplayController.js";
import { UndoStack } from "../interaction/UndoStack.js";
import { LabelExporter } from "../export/LabelExporter.js";
import { analyzeStrategy, computeBarContext, fmtHold } from "../signals/StrategyAnalyzer.js";
import { makeLiveProvider } from "../data/LiveProvider.js";
import { StreamController } from "../data/StreamController.js";
import { WebSocketStream }  from "../data/WebSocketStream.js";
import { runBacktest }       from "../backtest/Backtester.js";
import { AlertEngine }       from "../alerts/AlertEngine.js";
import { Journal }           from "../journal/Journal.js";
import { tfToMinutes }       from "../util/Aggregator.js";
import { MTFPanel }          from "../ui/MTFPanel.js";
import { RiskCalculator }    from "../ui/RiskCalculator.js";
import { runSignalScan, defaultStrategy, exportStrategyJSON, computeTradeStats } from "../signals/SignalEngine.js";
import { StrategyOverlay, exportStrategyToTradingApp } from "../strategies/StrategyOverlay.js";
import { SignalRuleEditor }  from "../signals/SignalRuleEditor.js";
import { optimizeStrategyAsync } from "../signals/SignalOptimizer.js";
import { ReportGenerator }       from "../util/ReportGenerator.js";
import { OptimizerPanel }        from "../ui/OptimizerPanel.js";
import { OptimizerEngine }       from "../optimizer/OptimizerEngine.js";

export class Engine {
  constructor(canvas, hudEl, statusEl, config) {
    this.canvas = canvas;
    this.hudEl = hudEl;
    this.statusEl = statusEl;
    this.ctx = canvas.getContext("2d", { alpha: false });

    this.state = createState();

    this.data = new DataEngine(config.provider, this.state);
    this.layout = new LayoutEngine(this.state);
    this.renderer = new Renderer(this.ctx, this.state, this.hudEl);

    this.undo = new UndoStack(this.state, () => this.render());
    this.exporter = new LabelExporter(this.state);

    this.replay = new ReplayController(
      this.state,
      () => this.render(),
      (msg) => this.setStatus(msg)
    );

    // Create interaction first
    this.interaction = new InteractionEngine(
      this.canvas,
      this.state,
      this.undo,
      () => this.render(),
      (msg) => this.setStatus(msg)
    );
    // Give InteractionEngine a back-reference so its context menu can call
    // engine-level methods like autoPlaceSignals() and clearSignals().
    this.interaction._engine = this;

    // Infinite left-load hook (DataEngine incremental reveal demo)
    this.interaction.setLeftLoadHook(() => {
      if (this.data.canLoadOlder && this.data.canLoadOlder()) {
        const ok = this.data.loadOlderChunk(1500);
        if (ok) {
          const after = this.state.bars[0]?.t;
          this.setStatus(`Loaded older history. Oldest: ${new Date(after).toLocaleString()}`);
          this.render();
        }
      }
    });

    // Pro-level subsystems
    this.stream     = new StreamController(this.state);
    this.wsStream   = new WebSocketStream();
    this.alerts     = new AlertEngine(this.state);
    this.journal    = new Journal(this.state);

    // MTF Panel — attached to #chartWrap
    const chartWrap = document.getElementById("chartWrap") ?? canvas.parentElement;
    this.mtfPanel   = new MTFPanel(chartWrap);

    // Risk Calculator — inject into renderer
    this.riskCalc = new RiskCalculator();
    this.renderer.riskCalc = this.riskCalc;

    // Signal Rule Editor
    this.signalEditor = new SignalRuleEditor(chartWrap);
    this.signalEditor.strategy = defaultStrategy(
      this.state.symbol,
      this.state.timeframe
    );
    this.signalEditor.onRun    = (strat) => this._runSignalScan(strat);
    this.signalEditor.onExport = (strat, stats) => this._exportStrategy(strat, stats);
    this.signalEditor.onOptimize        = (strat, extraOpts) => this._optimizeStrategy(strat, extraOpts);
    this.signalEditor.onGenerateReport  = (opts)            => this._generateFullReport(opts);
    this.signalEditor.onSendToOptimizer = (strategy)        => {
      this._optimizerPanel?.loadStrategy(strategy);
      this._optimizerPanel?.show();
    };
    this.signalEditor.onCancel  = () => {
      if (this._optimizerAbort) {
        this._optimizerAbort.abort();
        this._optimizerAbort = null;
        this.setStatus("Optimizer cancelled.");
        this.signalEditor.hideProgress();
      }
    };

    this._raf = 0;
    this._optimizerAbort  = null;  // AbortController for active run (used by SignalRuleEditor inline optimizer)
    this._optimizerWorker = null;  // kept for back-compat, unused

    // ── New standalone Optimizer (OptimizerPanel + OptimizerEngine) ──────────
    this._optimizerEngine = new OptimizerEngine({
      onProgress: (info) => {
        this._optimizerPanel?.updateProgress(info);
        this.setStatus(`${info.label} · ${info.detail ?? ''}`);
      },
      onComplete: (result) => {
        this._optimizerPanel?._renderResults(result, result._runOpts ?? {});
        this._optimizerPanel?._setRunning(false);
        this._optimizerPanel?._showProgress(false);
      },
      onError: (err) => {
        this.setStatus(`Optimizer error: ${err.message}`);
        this._optimizerPanel?._setRunning(false);
        this._optimizerPanel?._showProgress(false);
      },
    });

    // OptimizerPanel wired up lazily on first open (mount() called in show())
    const chartWrap2 = document.getElementById("chartWrap") ?? canvas.parentElement;
    this._optimizerPanel = new OptimizerPanel(this);
    this._optimizerPanel.onSendToEditor = (strategy) => this.receiveStrategyFromOptimizer(strategy);

    // ── Background strategy overlay (loads saved strategies from trading DB) ─
    this._strategyOverlay = new StrategyOverlay();
    this._strategyOverlay.onUpdate = () => {
      this.state.bgStrategySignals = this._strategyOverlay.getMergedSignals();
      this._updateStrategyOverlayPanel();
      this.render();
    };

    // Wire up "send to trading app" callback on SignalRuleEditor
    this.signalEditor.onExportToTradingApp = (strat, stats) =>
      this._sendStrategyToTradingApp(strat, stats);
  }

  async start() {
    await this.data.loadInitial();

    this.resize();
    window.addEventListener("resize", () => this.resize());

    this.interaction.attach();

    // Risk calculator: capture-phase listener fires BEFORE InteractionEngine's
    // bubble-phase pointerdown, so risk-mode clicks are consumed cleanly.
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.state.riskMode) return;
      if (e.button !== 0) return;
      const ps   = this.state._priceScale;
      const pane = this.state._panes?.price;
      if (!ps || !pane) return;
      const rect  = this.canvas.getBoundingClientRect();
      const dpr   = window.devicePixelRatio || 1;
      const cx    = (e.clientX - rect.left) * dpr;
      const cy    = (e.clientY - rect.top)  * dpr;
      if (cx >= pane.x && cx <= pane.x + pane.w &&
          cy >= pane.y && cy <= pane.y + pane.h) {
        const price = ps.pixToY(cy);
        const step  = this.state.risk.step;
        this.riskCalc.handleClick(price, this.state);
        e.stopImmediatePropagation();   // prevent panning / marker drag
        if (step === 0) {
          this.setStatus(`Risk: STOP set at ${price.toFixed(4)} — now click TARGET price`);
        } else if (step === 1) {
          const stop = this.state.risk.stopPrice;
          const dist = Math.abs(price - stop);
          this.setStatus(`Risk: target set. Stop dist ${dist.toFixed(4)} — click again to reset`);
        } else {
          this.setStatus("Risk Calc reset — click STOP price to start again");
        }
        this.render();
      }
    }, true /* capture */);

    this.render();
    this.loop();
  }

  loop() {
    const tick = (ts) => {
      this.replay.tick(ts);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  resetView() {
    const bars = this.state.bars;
    if (!bars.length) return;
    const n = bars.length;
    const lookback = Math.min(500, n);
    this.state.xDomain = [bars[n - lookback].t, bars[n - 1].t];
    this.render();
  }

  zoomBy(factor) {
    const [t0, t1] = this.state.xDomain;
    const span = t1 - t0;
    if (span <= 0) return;

    const anchor = (t0 + t1) * 0.5; // center zoom
    let newSpan = span * factor;

    const min = this.state.limits.minSpanMs;
    const max = this.state.limits.maxSpanMs;
    if (newSpan < min) newSpan = min;
    if (newSpan > max) newSpan = max;

    const newT0 = anchor - newSpan * 0.5;
    const newT1 = anchor + newSpan * 0.5;
    this.state.xDomain = [newT0, newT1];
    this.render();
  }

  zoomIn()  { this.zoomBy(0.82); }
  zoomOut() { this.zoomBy(1.22); }

  // Set timeframe: resamples bars and adjusts view span.
  setTimeframe(tf) {
    const SPANS = {
      "1m":  150  * 60_000,
      "5m":  390  * 60_000,
      "15m": 1170 * 60_000,
      "1h":  4    * 24 * 60 * 60_000,
      "4h":  16   * 24 * 60 * 60_000,
      "1D":  90   * 24 * 60 * 60_000,
    };
    const targetSpan = SPANS[tf] ?? SPANS["1h"];
    this.state.timeframe = tf;

    // Real resampling via DataEngine
    const tfMin = tfToMinutes(tf);
    if (this.data?.applyTimeframe) this.data.applyTimeframe(tfMin);

    const bars  = this.state.bars;
    const right = bars.length ? bars[bars.length - 1].t : this.state.xDomain[1];
    this.state.xDomain = [right - targetSpan, right];
    this.render();
  }

  /**
   * Load a new symbol from the live API.
   * Replaces all chart data; preserves UI state (replay paused, timeframe kept).
   * @param {string} symbol   e.g. "BTC"
   * @param {number} daysBack 1-365 (default 7)
   */
  async loadSymbol(symbol, daysBack = 30) {
    this.setStatus(`Loading ${symbol} · ${daysBack}d…`);

    // Stop stream before swapping data
    const wasStreaming = this.state.streaming;
    if (wasStreaming) this.stopStream();

    this.state.markers   = [];
    this.state.events    = [];
    this.state.positions = [];
    this.state.symbol    = symbol;

    const progressCb = (done, total) =>
      this.setStatus(`Loading ${symbol} · ${daysBack}d… (${done}/${total} windows)`);

    this.data = new DataEngine(makeLiveProvider(symbol, daysBack, progressCb), this.state);

    try {
      await this.data.loadInitial();
      this.resize();
      this.render();
      const rawBars  = this.data._all?.rawBars?.length ?? this.data._all?.bars?.length ?? 0;
      const allBars  = rawBars;
      if (allBars > 1) {
        const b = this.data._all?.rawBars ?? this.data._all?.bars;
        const spanMs   = b[b.length - 1].t - b[0].t;
        const spanDays = (spanMs / 86_400_000).toFixed(1);
        this.setStatus(`${symbol} · ${allBars.toLocaleString()} 1m bars · ${spanDays}d span`);
      } else {
        this.setStatus(`${symbol} loaded`);
      }
      if (wasStreaming) this.startStream();
      // Refresh MTF panel on new symbol
      if (this.state.mtfVisible) this.mtfPanel.refresh(this.state.rawBars);
      // Background: load stored strategies and overlay their signals
      this._runBackgroundStrategyLoad();
    } catch (err) {
      console.error("loadSymbol error:", err);
      this.setStatus(`Error loading ${symbol}: ${err.message}`);
    }
  }

  showStats() {
    const stats = this.state.pnlStats;
    if (!stats) {
      this.setStatus("No trades yet — add Buy + Sell markers to compute P&L");
      return;
    }
    let panel = document.getElementById("stats-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "stats-panel";
      panel.className = "stats-panel";
      document.body.appendChild(panel);
      panel.addEventListener("click", e => { if (e.target === panel) panel.classList.remove("open"); });
    }

    const { trades, wins, losses, winRate, totalPnl, avgPnl,
            bestTrade, worstTrade, avgHoldMs, avgWinHoldMs, avgLossHoldMs, tradeList } = stats;
    const sign = v => v >= 0 ? "+" : "";

    panel.innerHTML = `
      <div class="sp-box">
        <div class="sp-head">
          <span>P&amp;L Summary</span>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-accent sp-analyze-btn" id="sp-analyze-btn" style="font-size:11px;padding:3px 10px">Find Formula</button>
            <button class="sp-close" onclick="document.getElementById('stats-panel').classList.remove('open')">✕</button>
          </div>
        </div>
        <div class="sp-grid">
          <div class="sp-kv"><span class="sp-k">Trades</span><span class="sp-v">${trades}</span></div>
          <div class="sp-kv"><span class="sp-k">Win Rate</span><span class="sp-v ${winRate>=50?'bull':'bear'}">${winRate.toFixed(1)}%</span></div>
          <div class="sp-kv"><span class="sp-k">Total P&amp;L</span><span class="sp-v ${totalPnl>=0?'bull':'bear'}">${sign(totalPnl)}${totalPnl.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Avg P&amp;L</span><span class="sp-v ${avgPnl>=0?'bull':'bear'}">${sign(avgPnl)}${avgPnl.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Best</span><span class="sp-v bull">${sign(bestTrade)}${bestTrade.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Worst</span><span class="sp-v bear">${sign(worstTrade)}${worstTrade.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Avg Hold</span><span class="sp-v">${fmtHold(avgHoldMs)}</span></div>
          <div class="sp-kv"><span class="sp-k">Win Hold</span><span class="sp-v bull">${fmtHold(avgWinHoldMs)}</span></div>
          <div class="sp-kv"><span class="sp-k">Loss Hold</span><span class="sp-v bear">${fmtHold(avgLossHoldMs)}</span></div>
        </div>
        <div class="sp-trades">${(tradeList || []).slice(0,30).map((t,i) => `
          <div class="sp-trade ${t.win?'bull-row':'bear-row'}">
            <span class="sp-ti">#${i+1}</span>
            <span>${new Date(t.entryT).toLocaleDateString()}</span>
            <span class="sp-v ${t.win?'bull':'bear'}">${sign(t.pnl)}${t.pnl.toFixed(2)} (${sign(t.pct)}${t.pct.toFixed(2)}%)</span>
            <span class="sp-hold">${fmtHold(t.holdMs)}</span>
          </div>`).join('')}
        </div>
        <div id="sp-formula-section"></div>
      </div>`;

    // Wire the Find Formula button
    const analyzeBtn = panel.querySelector("#sp-analyze-btn");
    if (analyzeBtn) {
      analyzeBtn.onclick = () => this.analyzeStrategy();
    }

    panel.classList.add("open");
  }

  analyzeStrategy() {
    const stats = this.state.pnlStats;
    if (!stats || !stats.tradeList) {
      this.setStatus("No trades to analyse");
      return;
    }
    const result = analyzeStrategy(stats.tradeList);
    this._lastFormula = result;   // store so applyFormulaToChart can reach it

    const section = document.getElementById("sp-formula-section");
    if (section) {
      section.innerHTML = `
        <div class="sp-head" style="border-top:1px solid var(--border);border-bottom:none;margin-top:4px">
          <span>Strategy Formula</span>
        </div>
        ${result.html}`;

      // Wire the Plot on Chart button (injected inside formulaBox)
      const plotBtn = section.querySelector("#sf-plot-btn");
      if (plotBtn) plotBtn.onclick = () => this.applyFormulaToChart();
    }
  }

  /**
   * Scan all loaded bars using the best-condition formula and place
   * Buy markers wherever the condition fires, Sell markers at holdMs later.
   */
  applyFormulaToChart() {
    const formula = this._lastFormula;
    if (!formula || !formula.bestCond) {
      this.setStatus("Run \"Find Formula\" first");
      return;
    }

    const { bestCond, bestHold } = formula;
    const stats   = this.state.pnlStats;
    const bars    = this.state.bars;
    if (!bars.length) return;

    // Hold duration: prefer best-hold bucket avg, else overall avg, else 20 bars
    const holdMs = (bestHold?.avgHoldMs ?? stats?.avgHoldMs ?? 0)
                   || (20 * 60_000);

    // Minimum gap between entries (avoid piling in on sustained signals)
    const minGapMs = holdMs * 0.5;

    const newMarkers = [];
    let lastEntryT   = -Infinity;
    let uid          = Date.now();

    for (let i = 20; i < bars.length; i++) {          // skip first 20 (SMA warmup)
      const bar = bars[i];
      // Enforce minimum spacing between buys
      if (bar.t - lastEntryT < minGapMs) continue;

      const ctx = computeBarContext(bars, i, this.state);
      if (!bestCond.testFn(ctx)) continue;

      // Find exit bar (nearest bar at entry.t + holdMs)
      const targetExitT = bar.t + holdMs;
      let exitIdx = i + 1;
      while (exitIdx < bars.length - 1 && bars[exitIdx].t < targetExitT) exitIdx++;

      newMarkers.push({ id: `f_${uid++}`, t: bar.t,             kind: "buy",  pane: "lane", formula: true });
      newMarkers.push({ id: `f_${uid++}`, t: bars[exitIdx].t,   kind: "sell", pane: "lane", formula: true });
      lastEntryT = bar.t;
    }

    if (!newMarkers.length) {
      this.setStatus("Formula matched 0 bars — try a different symbol or date range");
      return;
    }

    const replace = this.state.markers.length === 0
      || confirm(`Replace ${this.state.markers.length} existing signal(s) with ${newMarkers.length / 2} formula trades?`);
    if (!replace) return;

    this.state.markers = newMarkers;
    this.state.selectedMarkerId = null;
    this.render();

    // Scroll/zoom to the first formula trade
    const firstT = newMarkers[0].t;
    const lastT  = newMarkers[newMarkers.length - 1].t;
    const span   = Math.max(lastT - firstT, holdMs * 4);
    this.state.xDomain = [firstT - span * 0.05, firstT + span * 1.05];
    this.render();

    this.setStatus(`Plotted ${newMarkers.length / 2} formula trades — "${bestCond.label}"`);
  }

  exportForAI() {
    this.exporter.downloadLabels();
    this.setStatus("Exported labels + P&L for AI analysis");
  }

  /** Remove all user-placed markers */
  clearSignals() {
    const before = this.state.markers.length;
    this.state.markers = [];
    this.state.selectedMarkerId = null;
    this.render();
    this.setStatus(`Cleared ${before} signal${before !== 1 ? "s" : ""}`);
  }

  /**
   * Auto-place Buy at every swing trough and Sell at every swing peak
   * in the currently visible range.
   *
   * Algorithm — proper zigzag swing detector:
   *  1. Scan with a small adaptive window (2% of visible bars) to find all
   *     candidate local lows and highs independently.
   *  2. Merge + sort by time, then apply a zigzag pass: enforce strictly
   *     alternating buy→sell→buy…  When two consecutive signals of the same
   *     type appear, keep only the more extreme one (lower trough, higher peak).
   *  3. Apply a percentage-based prominence gate: each swing must be at least
   *     `threshold`% of the average price to filter out noise. Auto-derived
   *     from price volatility so it works across any zoom level.
   */
  autoPlaceSignals() {
    const bars = this.state.bars;

    if (bars.length < 10) {
      this.setStatus("Not enough bars loaded to detect peaks/troughs");
      return;
    }

    // Run over ALL loaded bars so the entire chart is covered.
    // Window scales to ~1.5% of total bar count (clamped 3–20).
    const visible = bars;
    const win = Math.max(3, Math.min(20, Math.floor(visible.length * 0.015)));

    // Adaptive prominence: swing size must exceed ~1.2× the median bar range
    const ranges = visible.map(b => b.h - b.l).sort((a, b) => a - b);
    const medianRange = ranges[Math.floor(ranges.length / 2)] || 0.01;
    const minProm = medianRange * 1.2;

    // ── Pass 1: find all raw candidate extrema ───────────────
    const candidates = [];
    for (let i = win; i < visible.length - win; i++) {
      const b = visible[i];

      // Strict local low: b.l is the minimum of all lows in [i-win, i+win]
      let isLow = true;
      for (let j = i - win; j <= i + win; j++) {
        if (j !== i && visible[j].l <= b.l) { isLow = false; break; }
      }
      if (isLow) { candidates.push({ i, t: b.t, price: b.l, kind: "buy"  }); continue; }

      // Strict local high: b.h is the maximum of all highs in [i-win, i+win]
      let isHigh = true;
      for (let j = i - win; j <= i + win; j++) {
        if (j !== i && visible[j].h >= b.h) { isHigh = false; break; }
      }
      if (isHigh) candidates.push({ i, t: b.t, price: b.h, kind: "sell" });
    }

    // ── Pass 2: zigzag filter ────────────────────────────────
    // Enforce alternating buy/sell; when same-type repeats keep the
    // more extreme value; apply prominence gate between consecutive pivots.
    const zigzag = [];
    for (const c of candidates) {
      if (zigzag.length === 0) {
        zigzag.push(c);
        continue;
      }
      const prev = zigzag[zigzag.length - 1];

      if (c.kind === prev.kind) {
        // Same type: keep the more extreme pivot
        if (c.kind === "buy"  && c.price < prev.price) zigzag[zigzag.length - 1] = c;
        if (c.kind === "sell" && c.price > prev.price) zigzag[zigzag.length - 1] = c;
      } else {
        // Alternating: apply prominence gate
        const swing = Math.abs(c.price - prev.price);
        if (swing >= minProm) {
          zigzag.push(c);
        } else {
          // Swing too small — absorb into the previous pivot (keep more extreme)
          if (c.kind === "buy"  && c.price < prev.price) zigzag[zigzag.length - 1] = c;
          if (c.kind === "sell" && c.price > prev.price) zigzag[zigzag.length - 1] = c;
        }
      }
    }

    // ── Build markers, deduplicate against existing ──────────
    const existing = this.state.markers;
    let idBase = Date.now();
    const filtered = zigzag
      .map(z => ({ id: idBase++, t: z.t, kind: z.kind, pane: "lane", source: "peaks", price: z.price }))
      .filter(nm => !existing.some(em => Math.abs(em.t - nm.t) < win * 60_000));

    this.state.markers = [...existing, ...filtered];
    this.render();

    const buys  = filtered.filter(m => m.kind === "buy").length;
    const sells = filtered.filter(m => m.kind === "sell").length;
    this.setStatus(`Auto-placed ${filtered.length} signals — ${buys} buy, ${sells} sell  (window = ${win} bars)`);
  }

  // ── Streaming ──────────────────────────────────────────────────────────────
  startStream() {
    const symbol = this.state.symbol ?? "BTC";

    // Try WebSocket first; fall back to HTTP polling
    this.wsStream.connect(
      symbol,
      (tick) => {
        // Merge tick into the last bar (or append if it crosses a minute boundary)
        const bars = this.state.bars;
        if (bars.length && tick.close) {
          const last = bars[bars.length - 1];
          last.c = tick.close;
          if (tick.high  > last.h) last.h = tick.high;
          if (tick.low   < last.l) last.l = tick.low;
        }
        this.alerts.evaluate();
        this.updateLiveTapeDOM();
        this.render();
      },
      () => {
        // WS failed — start HTTP polling fallback
        this.stream.start(symbol, 30_000, () => {
          this.alerts.evaluate();
          this.render();
        });
        this.setStatus("Live stream ON (polling)");
      },
      this.state
    );

    this.state.streaming = true;
    const pulse = document.getElementById("livePulse");
    if (pulse) pulse.classList.add("active");
    this.setStatus("Live stream ON");
  }

  stopStream() {
    this.wsStream?.disconnect();
    this.stream.stop();
    this.state.streaming = false;
    const pulse = document.getElementById("livePulse");
    if (pulse) pulse.classList.remove("active");
    this._liveTapeEl = null;
    this.setStatus("Live stream OFF");
  }

  // ── New Phase-12 methods ─────────────────────────────────────────────────

  toggleVPVR() { this.toggleIndicator("vpvr"); }
  toggleSMC()  { this.toggleIndicator("smc");  }

  toggleMTF() {
    this.state.mtfVisible = !this.state.mtfVisible;
    if (this.state.mtfVisible) {
      this.mtfPanel.show();
      this.mtfPanel.refresh(this.state.rawBars);
    } else {
      this.mtfPanel.hide();
    }
  }

  setRiskMode(on) {
    if (!on) {
      this.riskCalc.deactivate(this.state);
      this.canvas.style.cursor = "default";
      this.setStatus("Risk calculator OFF");
    } else {
      this.state.riskMode = true;
      this.state.risk.step = 0;
      this.canvas.style.cursor = "crosshair";
      this.setStatus("Risk Calc: click to set STOP price");
    }
    this.render();
  }

  toggleRiskMode() {
    this.setRiskMode(!this.state.riskMode);
  }

  updateLiveTapeDOM() {
    let el = document.getElementById("live-tape");
    if (!el) return;
    const tape = this.state.liveTape;
    if (!tape?.length) return;
    el.innerHTML = tape.slice().reverse().slice(0, 20).map(t => {
      const cls = t.side === "buy" ? "tape-buy" : "tape-sell";
      const arrow = t.side === "buy" ? "▲" : "▼";
      return `<div class="tape-row ${cls}"><span class="tape-arrow">${arrow}</span><span class="tape-price">${(+t.price).toFixed(2)}</span></div>`;
    }).join("");
  }

  toggleStream() {
    if (this.state.streaming) this.stopStream();
    else this.startStream();
  }

  // ── Drawing tools ───────────────────────────────────────────────────────────
  setDrawingMode(mode) {   // null | "hline" | "trendline"
    this.state.drawingMode = mode;
    this.state._drawingInProgress = null;
    this.canvas.style.cursor = mode ? "crosshair" : "default";
    this.setStatus(mode ? `Drawing: ${mode} — click to place` : "Drawing cancelled");
  }

  clearDrawings() {
    this.state.drawings = [];
    this.state.selectedDrawingId = null;
    this.render();
    this.setStatus("Drawings cleared");
  }

  // ── Indicator toggles ───────────────────────────────────────────────────────
  toggleIndicator(name) {
    this.state.indicators[name] = !this.state.indicators[name];
    this.render();
    this.setStatus(`${name.toUpperCase()} ${this.state.indicators[name] ? "ON" : "OFF"}`);
  }

  // ── Backtest ────────────────────────────────────────────────────────────────
  runBacktest() {
    const formula = this._lastFormula;
    if (!formula?.bestCond) {
      this.setStatus("Run \"Find Formula\" first, then backtest");
      return;
    }
    const { bestCond, bestHold } = formula;
    const holdMs = bestHold?.avgHoldMs ?? (20 * 60_000);
    const result = runBacktest(this.state.bars, this.state, bestCond.testFn, holdMs);
    this.showBacktestResults(result);
  }

  showBacktestResults(result) {
    let panel = document.getElementById("bt-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "bt-panel";
      panel.className = "stats-panel";
      document.body.appendChild(panel);
      panel.addEventListener("click", e => { if (e.target === panel) panel.classList.remove("open"); });
    }
    const s = v => v >= 0 ? "+" : "";
    const pct = v => (v * 100).toFixed(2);
    panel.innerHTML = `
      <div class="sp-box">
        <div class="sp-head">
          <span>Backtest Results</span>
          <button class="sp-close" onclick="document.getElementById('bt-panel').classList.remove('open')">✕</button>
        </div>
        <div class="sp-grid">
          <div class="sp-kv"><span class="sp-k">Trades</span><span class="sp-v">${result.tradeCount}</span></div>
          <div class="sp-kv"><span class="sp-k">Win Rate</span><span class="sp-v ${result.winRate>=50?'bull':'bear'}">${result.winRate.toFixed(1)}%</span></div>
          <div class="sp-kv"><span class="sp-k">Return</span><span class="sp-v ${result.totalReturn>=0?'bull':'bear'}">${s(result.totalReturn)}${pct(result.totalReturn)}%</span></div>
          <div class="sp-kv"><span class="sp-k">Final Equity</span><span class="sp-v">${result.finalEquity.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Max Drawdown</span><span class="sp-v bear">-${pct(result.maxDrawdown)}%</span></div>
          <div class="sp-kv"><span class="sp-k">Sharpe</span><span class="sp-v">${result.sharpe.toFixed(2)}</span></div>
          <div class="sp-kv"><span class="sp-k">Profit Factor</span><span class="sp-v ${result.profitFactor>=1?'bull':'bear'}">${result.profitFactor.toFixed(2)}</span></div>
        </div>
        <canvas id="bt-equity-canvas" width="480" height="100" style="width:100%;height:100px;margin-top:8px;border-radius:4px;background:#0d1117"></canvas>
      </div>`;
    panel.classList.add("open");

    // Draw mini equity curve
    const cvs = panel.querySelector("#bt-equity-canvas");
    if (cvs && result.equity?.length) {
      const c2 = cvs.getContext("2d");
      const eq = result.equity;
      const W = cvs.width, H = cvs.height;
      const mn = Math.min(...eq), mx = Math.max(...eq);
      const range = mx - mn || 1;
      c2.strokeStyle = "#26a69a"; c2.lineWidth = 1.5;
      c2.beginPath();
      eq.forEach((v, i) => {
        const x = (i / (eq.length - 1)) * W;
        const y = H - ((v - mn) / range) * (H - 8) - 4;
        i === 0 ? c2.moveTo(x, y) : c2.lineTo(x, y);
      });
      c2.stroke();
    }
  }

  // ── Journal / Alerts UI ─────────────────────────────────────────────────────
  showJournal() {
    this.journal.showPanel(
      (id) => { this.journal.restore(id); this.render(); },
      () => {}
    );
  }

  showAlerts() {
    let panel = document.getElementById("alerts-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "alerts-panel";
      panel.className = "stats-panel";
      document.body.appendChild(panel);
      panel.addEventListener("click", e => { if (e.target === panel) panel.classList.remove("open"); });
    }
    const list = this.alerts.list();
    panel.innerHTML = `
      <div class="sp-box">
        <div class="sp-head">
          <span>Alerts (${list.length})</span>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-accent" id="al-add-btn" style="font-size:11px;padding:3px 10px">+ Add</button>
            <button class="sp-close" onclick="document.getElementById('alerts-panel').classList.remove('open')">✕</button>
          </div>
        </div>
        <div id="al-list">${list.length ? list.map(a => `
          <div class="sp-trade" style="gap:8px">
            <span style="flex:1;color:#ccc">${a.type} ${a.value ?? ""}</span>
            <span style="color:#888;font-size:11px">${a.symbol ?? ""}</span>
            <button class="btn" style="font-size:10px;padding:2px 6px" onclick="window._engine.alerts.remove('${a.id}');window._engine.showAlerts()">✕</button>
          </div>`).join("") : '<div style="color:#666;padding:12px;text-align:center">No alerts</div>'}
        </div>
        <div id="al-form" style="padding:8px;display:none;border-top:1px solid var(--border)">
          <select id="al-type" style="width:100%;margin-bottom:6px;background:#1e2a3a;border:1px solid #2a3a4a;color:#ccc;padding:4px;border-radius:4px">
            <option value="price_above">Price Above</option>
            <option value="price_below">Price Below</option>
            <option value="rsi_above">RSI Above</option>
            <option value="rsi_below">RSI Below</option>
            <option value="ema_cross_bull">EMA Cross Bull</option>
            <option value="ema_cross_bear">EMA Cross Bear</option>
          </select>
          <input id="al-val" type="number" placeholder="Value" style="width:100%;margin-bottom:6px;background:#1e2a3a;border:1px solid #2a3a4a;color:#ccc;padding:4px;border-radius:4px;box-sizing:border-box" />
          <div style="display:flex;gap:6px">
            <button class="btn btn-accent" id="al-save-btn" style="flex:1">Save</button>
            <button class="btn" id="al-cancel-btn" style="flex:1">Cancel</button>
          </div>
        </div>
      </div>`;
    panel.classList.add("open");

    panel.querySelector("#al-add-btn").onclick = () => {
      panel.querySelector("#al-form").style.display = "";
    };
    panel.querySelector("#al-cancel-btn").onclick = () => {
      panel.querySelector("#al-form").style.display = "none";
    };
    panel.querySelector("#al-save-btn").onclick = () => {
      const type  = panel.querySelector("#al-type").value;
      const value = parseFloat(panel.querySelector("#al-val").value);
      this.alerts.add({ type, value, symbol: this.state.symbol });
      this.showAlerts();
    };
  }

  addAlert(cfg) { this.alerts.add(cfg); }

  // ── Keyboard signal placement ───────────────────────────────────────────────
  placeSignalAtCursor(kind) {   // "buy" | "sell"
    const scene = this.state._scene;
    if (!scene) return;
    // Use the crosshair time if available, otherwise last bar
    const t = this.state.crosshairT
           ?? this.state.bars[this.state.bars.length - 1]?.t;
    if (t == null) return;
    const id = `kb_${Date.now()}`;
    this.state.markers.push({ id, t, kind, pane: "lane" });
    this.render();
    this.setStatus(`${kind.toUpperCase()} signal placed at ${new Date(t).toLocaleString()}`);
  }

  // ── Signal scan ────────────────────────────────────────────────────────────
  toggleSignalEditor() {
    if (!this.signalEditor) return;
    // Keep strategy meta in sync with current symbol / TF
    this.signalEditor.strategy.meta.symbol    = this.state.symbol;
    this.signalEditor.strategy.meta.timeframe = this.state.timeframe;
    this.signalEditor.toggle();
  }

  _runSignalScan(strategy) {
    if (!strategy) {
      // Clear
      this.state.computedSignals = [];
      this.state.computedTrades  = [];
      this.render();
      this.setStatus("Signals cleared.");
      return;
    }
    const bars = this.data._all?.bars ?? this.state.bars;
    if (!bars.length) { this.setStatus("No bars loaded — cannot run scan."); return; }

    let signals, trades, stats;
    const dir = strategy.entry.direction;

    if (dir === "both") {
      // Run long scan then flip conditions for short scan, merge results
      const longStrat  = JSON.parse(JSON.stringify(strategy));
      longStrat.entry.direction = "long";

      const shortStrat = JSON.parse(JSON.stringify(strategy));
      shortStrat.entry.direction = "short";
      shortStrat.entry.conditions = shortStrat.entry.conditions.map(c => {
        const flip = { ema_cross_up:"ema_cross_down", ema_cross_down:"ema_cross_up",
          ema_above_slow:"ema_below_slow", ema_below_slow:"ema_above_slow",
          price_above_ema:"price_below_ema", price_below_ema:"price_above_ema",
          macd_hist_pos:"macd_hist_neg", macd_hist_neg:"macd_hist_pos",
          macd_above_signal:"macd_below_signal", macd_below_signal:"macd_above_signal",
          rsi_oversold:"rsi_overbought", rsi_overbought:"rsi_oversold",
          price_above_vwap:"price_below_vwap", price_below_vwap:"price_above_vwap",
          higher_high:"lower_low", lower_low:"higher_high",
        };
        return flip[c.id] ? { ...c, id: flip[c.id] } : c;
      });

      const longResult  = runSignalScan(bars, longStrat);
      const shortResult = runSignalScan(bars, shortStrat);

      // Merge and sort by time
      signals = [...longResult.signals, ...shortResult.signals]
        .sort((a, b) => a.t - b.t);
      trades  = [...longResult.trades,  ...shortResult.trades]
        .sort((a, b) => a.entryT - b.entryT);

      stats = computeTradeStats(trades);
    } else {
      ({ signals, trades, stats } = runSignalScan(bars, strategy));
    }

    this.state.computedSignals = signals;
    this.state.computedTrades  = trades;
    strategy.backtest_summary  = stats;

    this.signalEditor.updateStats(stats, signals.length, trades.length);
    this.render();

    const arrow = dir === "long" ? "▲" : dir === "short" ? "▼" : "▲▼";
    this.setStatus(
      `${arrow} ${signals.length} signals → ${trades.length} trades · ` +
      `WR ${stats.win_rate}% · PF ${stats.profit_factor ?? "∞"} · Net $${stats.net_pnl_usd}`
    );
  }

  _exportStrategy(strategy, stats) {
    strategy.meta.symbol    = this.state.symbol;
    strategy.meta.timeframe = this.state.timeframe;
    const json = exportStrategyJSON(strategy, stats);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `strategy_${strategy.meta.symbol}_${strategy.meta.timeframe}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus(`Exported strategy JSON for ${strategy.meta.symbol} / ${strategy.meta.timeframe}`);
  }

  // ── Trading App Integration ────────────────────────────────────────────────

  /** Fire-and-forget: load all saved strategies from trading DB onto current bars */
  _runBackgroundStrategyLoad() {
    const bars = this.data._all?.bars ?? this.state.bars;
    if (!bars?.length) return;
    // Clear stale signals immediately so old overlays don't hang around
    this.state.bgStrategySignals = [];
    this._strategyOverlay.load(bars).catch(err =>
      console.warn('[Engine] Background strategy load failed:', err.message)
    );
  }

  /**
   * Populate the #stratOverlayList panel in the chart toolbar with one
   * checkbox row per loaded background strategy.  Called by the
   * _strategyOverlay.onUpdate callback after signals are (re)computed.
   */
  _updateStrategyOverlayPanel() {
    const section = document.getElementById('stratOverlaySection');
    const list    = document.getElementById('stratOverlayList');
    if (!section || !list) return;

    const strategies = this._strategyOverlay.strategies;
    if (!strategies || strategies.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    list.innerHTML = '';

    for (const s of strategies) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 4px;border-radius:3px;';
      row.title = s.strategy_name ?? String(s.id);

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = s.enabled !== false;
      cb.dataset.stratId = s.id;
      cb.addEventListener('change', () => {
        this._strategyOverlay.toggle(s.id);
        this.state.bgStrategySignals = this._strategyOverlay.getMergedSignals();
        this.render();
      });

      const dot = document.createElement('span');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${s.colour ?? '#888'};`;

      const lbl = document.createElement('span');
      lbl.textContent = s.strategy_name ?? s.name ?? String(s.id);
      lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';

      row.append(cb, dot, lbl);
      list.appendChild(row);
    }
  }

  /** POST a strategy to the trading app DB; called from SignalRuleEditor + OptimizerPanel */
  async _sendStrategyToTradingApp(strategy, stats) {
    if (!strategy) return;
    strategy.meta.symbol    = this.state.symbol;
    strategy.meta.timeframe = this.state.timeframe;
    this.setStatus('Exporting strategy to trading app…');
    try {
      const result = await exportStrategyToTradingApp(strategy, stats);
      this.setStatus(`✓ Strategy added to trading app: ${strategy.meta.name ?? strategy.meta.symbol}`);
      return result;
    } catch (err) {
      this.setStatus(`Export to trading app failed: ${err.message}`);
      throw err;
    }
  }

  _optimizeStrategy(strategy, extraOpts = {}) {
    const bars = this.data._all?.bars ?? this.state.bars;
    if (!bars.length) { this.setStatus("No bars loaded — cannot optimize."); return; }

    // Prevent double-launch
    if (this._optimizerAbort) {
      this.setStatus("Optimizer already running — please wait.");
      return;
    }

    const original = JSON.parse(JSON.stringify(strategy));
    this._optimizerAbort = new AbortController();

    const phaseLabel = { 0: "P0 conditions", 1: "P1 entry params", 2: "P2 exit params",
                         3: "P3 dir/logic", "3b": "P3b gate inject", 4: "P4 walk-fwd",
                         5: "P5 SQS", 6: "P6 ensemble", 7: "P7 pivot scan", 8: "P8 multi-TF" };

    this.signalEditor.showProgress(0, -1, `Starting · ${bars.length.toLocaleString()} bars`);
    this.setStatus(`Optimizer started · ${bars.length.toLocaleString()} bars`);

    optimizeStrategyAsync(bars, strategy, {
      topN:       5,
      signal:     this._optimizerAbort.signal,
      autoPivot:       extraOpts.autoPivot       ?? false,
      multiTF:         extraOpts.multiTF         ?? false,
      preferHigherTF:  extraOpts.preferHigherTF  ?? false,
      baseTF:     this.state.timeframe ?? "15m",
      progressCb: ({ phase, tested, total }) => {
        const label = phaseLabel[phase] ?? `Pass ${phase}`;
        const pct   = total && total !== "?" ? Math.round((tested / +total) * 100) : -1;
        const pctStr = pct >= 0 ? `${pct}%` : `${tested} combos`;
        this.signalEditor.showProgress(phase, pct, `${label} · ${pctStr}`);
        this.setStatus(`Optimizer ${label}: ${tested}${total !== "?" ? `/${total}` : ""}…`);
      },
    }).then(result => {
      this._optimizerAbort = null;
      this._finishOptimize(result, original);
    }).catch(err => {
      this._optimizerAbort = null;
      this.signalEditor.hideProgress();
      this.setStatus(`Optimizer error: ${err.message}`);
    });
  }

  _finishOptimize(result, original) {
    this.signalEditor.hideProgress();
    this.signalEditor.showOptimizeResults(result, original);

    const { passStats } = result;
    const top    = result.topResults[0];
    const pfStr  = top?.stats?.profit_factor?.toFixed(2) ?? "?";
    const wrStr  = top?.stats?.win_rate ?? "?";
    const found  = passStats.foundProfitable ? "✓ profitable found" : "⚠ no profitable — showing best";
    const oos    = passStats.oosValidCount   ? ` · ${passStats.oosValidCount} OOS-valid` : "";
    const sqs    = passStats.recommendedMinSQS > 0 ? ` · SQS≥${passStats.recommendedMinSQS}` : "";
    const expand = passStats.expandedSearch   ? " (expanded)" : "";
    this.setStatus(
      `Optimizer: ${passStats.totalCombos} combos · ${passStats.elapsedMs}ms · ` +
      `best PF ${pfStr} · WR ${wrStr}% · ${found}${oos}${sqs}${expand}`
    );
  }

  /** @deprecated — kept for back-compat; not called */
  _runOptimizerSync() {}

  // ─── New OptimizerPanel / OptimizerEngine public API ─────────────────────

  /**
   * Open/close the standalone Optimizer overlay panel.
   */
  toggleOptimizerPanel() {
    this._optimizerPanel?.toggle();
  }

  /**
   * Run the full optimizer via OptimizerEngine.
   * Called by OptimizerPanel — resolves when done or cancelled.
   *
   * @param {object[]} bars
   * @param {object}   strategy
   * @param {object}   opts  — see OptimizerEngine DEFAULTS
   * @returns {Promise<object|null>}
   */
  async runOptimizer(bars, strategy, opts = {}) {
    return this._optimizerEngine.run(bars, strategy, {
      baseTF: this.state.timeframe ?? '15m',
      ...opts,
    });
  }

  /**
   * Cancel any running optimizer (OptimizerEngine or legacy inline optimizer).
   */
  cancelOptimizer() {
    this._optimizerEngine?.cancel();
    if (this._optimizerAbort) {
      this._optimizerAbort.abort();
      this._optimizerAbort = null;
      this.signalEditor?.hideProgress();
    }
  }

  /**
   * Quick single-pass scan across all TFs — delegates to OptimizerEngine.
   * @param {object[]} bars
   * @param {object}   strategy
   * @param {string[]} [tfs]
   */
  async quickScanAllTFs(bars, strategy, tfs) {
    return this._optimizerEngine.quickScanAllTFs(bars, strategy, tfs);
  }

  /**
   * Generate a full HTML + JSON report from an existing optimizer result.
   * Downloads the JSON and injects the HTML into the optimizer panel's results area.
   *
   * @param {object}   optimizerResult — return value of runOptimizer()
   * @param {object}   opts — { bars, strategy, topN }
   */
  async generateOptimizerReport(optimizerResult, opts = {}) {
    const bars     = opts.bars     ?? this.data._all?.bars ?? this.state.bars;
    const strategy = opts.strategy ?? optimizerResult?.best ?? this.signalEditor?.strategy;
    if (!bars?.length || !strategy) { this.setStatus('No bars/strategy for report'); return; }

    const symbol = this.state.symbol   ?? '–';
    const baseTF = this.state.timeframe ?? '15m';
    const panel  = this._optimizerPanel;

    // Wire progress into the optimizer panel's bar if it's open
    const showProgress = panel?.isVisible;
    if (showProgress) {
      panel._showProgress(true);
      panel._setProgress(0, 'Starting full report…');
      panel._setHeaderSub(`Full Report for ${symbol}…`);
    }
    this.setStatus(`Generating full report for ${symbol} @ ${baseTF}…`);

    let phasePct = 0;
    const progressCb = ({ label, pct }) => {
      phasePct = pct >= 0 ? pct : phasePct;
      const norm = Math.min(phasePct, 100) / 100;
      if (showProgress) panel._setProgress(norm, label ?? 'Working…');
      this.setStatus(label ?? 'Generating report…');
    };

    try {
      const report = await ReportGenerator.generateFullReport(bars, strategy, {
        symbol,
        baseTF,
        topN:       opts.topN ?? 3,
        optResult:  optimizerResult,   // skip re-running the optimizer
        progressCb,
      });
      if (!report) {
        this.setStatus('Report returned no data.');
        if (showProgress) panel._showProgress(false);
        return;
      }

      if (showProgress) panel._setProgress(1, 'Building report…');

      // ── Open HTML in a new window (leaves the optimizer panel intact) ────
      const win = window.open('', '_blank', 'width=1100,height=780,scrollbars=yes');
      if (win) {
        win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report — ${symbol}</title></head><body style="margin:0;background:#0d1020">${report.html}</body></html>`);
        win.document.close();
      } else {
        // Pop-up blocked — fall back to injecting into panel's dedicated report area
        let reportEl = panel?._el?.querySelector('#optReportArea');
        if (!reportEl && panel?._el) {
          reportEl = Object.assign(document.createElement('div'), { id: 'optReportArea' });
          reportEl.style.cssText = 'margin-top:12px;overflow-x:auto';
          panel._el.querySelector('.opt-col-results')?.appendChild(reportEl);
        }
        if (reportEl) reportEl.innerHTML = report.html;
      }

      // ── Download JSON (attach to body for Firefox compatibility) ────────
      const blob = new Blob(
        [JSON.stringify({ summary: report.summary, detailed: report.detailed }, null, 2)],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(blob);
      const a   = Object.assign(document.createElement('a'), {
        href:     url,
        download: `report_${symbol.replace('/', '')}_${baseTF}_${Date.now()}.json`,
        style:    'display:none',
      });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);

      const msg = `Report: ${report.summary.total_strategies_tested} combos · best PF ${report.summary.best_pf}` +
        ` on ${report.summary.best_tf} · ${report.summary.profitable_count}/${report.summary.total_entries} profitable`;
      this.setStatus(msg);
      if (showProgress) {
        panel._setProgress(1, 'Report complete — JSON downloaded');
        panel._setHeaderSub('Report complete');
        setTimeout(() => panel._showProgress(false), 2500);
      }
    } catch (err) {
      console.error('[Engine] generateOptimizerReport:', err);
      this.setStatus(`Report error: ${err.message}`);
      if (showProgress) {
        panel._setProgress(0, `Error: ${err.message}`);
        setTimeout(() => panel._showProgress(false), 3000);
      }
    }
  }

  /**
   * Load a strategy returned from the optimizer into the SignalRuleEditor.
   * Called when user clicks "Send Best to Editor" in OptimizerPanel.
   * @param {object} strategy
   */
  receiveStrategyFromOptimizer(strategy) {
    if (!strategy || !this.signalEditor) return;
    // SignalRuleEditor stores strategy as a plain property + calls _refresh() to redraw
    this.signalEditor.strategy = strategy;
    if (typeof this.signalEditor._refresh === 'function') {
      this.signalEditor._refresh();
    }
    this.signalEditor.show?.();
    this.setStatus('Best strategy loaded into Signal Editor');
  }

  render() {
    const scene = this.layout.computeScene(this.canvas);
    this.state._scene = scene;
    this.renderer.draw(scene);
  }

  // ─── Full Report Generation ─────────────────────────────────────────────

  async _generateFullReport(opts = {}) {
    const bars     = this.data._all?.bars ?? this.state.bars;
    const strategy = opts.strategy ?? this.signalEditor?.strategy;
    if (!bars?.length || !strategy) { this.setStatus("No bars/strategy — cannot generate report."); return; }

    const symbol = this.state.symbol   ?? "–";
    const baseTF = this.state.timeframe ?? opts.baseTF ?? "15m";

    this.setStatus(`Generating full report for ${symbol} @ ${baseTF}…`);
    this.signalEditor?.showProgress("rpt", -1, "Generating full report…");

    let report = null;
    const ac = new AbortController();
    this._reportAbort = ac;

    try {
      report = await ReportGenerator.generateFullReport(bars, strategy, {
        symbol,
        baseTF,
        topN:    opts.topN ?? 3,
        signal:  ac.signal,
        progressCb: ({ label, pct }) => {
          this.signalEditor?.showProgress("rpt", pct, label ?? "Generating…");
          this.setStatus(label ?? "Generating report…");
        },
      });
    } catch (e) {
      this.setStatus("Report generation failed: " + (e.message ?? e));
      this.signalEditor?.hideProgress();
      this._reportAbort = null;
      return;
    }

    this._reportAbort = null;
    this.signalEditor?.hideProgress();

    if (!report) { this.setStatus("Report returned no data."); return; }

    // Download as JSON
    const blob = new Blob([JSON.stringify({ summary: report.summary, detailed: report.detailed }, null, 2)],
      { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `report_${symbol.replace("/","")}_${baseTF}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Show HTML inline in opt-results panel
    const el = this.signalEditor?._panel?.querySelector("#sreOptResults");
    if (el) el.innerHTML = report.html;

    this.setStatus(
      `Report: ${report.summary.total_strategies_tested} combos · best PF ${report.summary.best_pf} ` +
      `on ${report.summary.best_tf} · ${report.summary.profitable_count}/${report.summary.total_entries} profitable`
    );
  }
}