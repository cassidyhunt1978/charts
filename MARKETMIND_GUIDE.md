# MarketMind Charts — Comprehensive Feature Guide

> **Stack:** Plain ES modules, no bundler. Entry: `src/main.js` loaded as `<script type="module">`.  
> **API:** `http://172.16.1.92:8012` — REST candle server with 23 symbols.  
> **Default fees:** Kraken Pro — 0.40% entry (taker) + 0.25% exit (maker) = **0.65% round-trip**.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Layer](#2-data-layer)
3. [Chart Rendering](#3-chart-rendering)
4. [Interaction & Drawing Tools](#4-interaction--drawing-tools)
5. [Signal Engine](#5-signal-engine)
6. [Market Regime Engine](#6-market-regime-engine)
7. [Signal Quality Score (SQS)](#7-signal-quality-score-sqs)
8. [Strategy Optimizer](#8-strategy-optimizer)
9. [Backtester](#9-backtester)
10. [Streaming & Live Data](#10-streaming--live-data)
11. [Alerts Engine](#11-alerts-engine)
12. [Trade Journal](#12-trade-journal)
13. [Multi-Timeframe Panel](#13-multi-timeframe-panel)
14. [Risk Calculator](#14-risk-calculator)
15. [Watchlist](#15-watchlist)
16. [Replay Controller](#16-replay-controller)
17. [UI Panels & Controls](#17-ui-panels--controls)
18. [Module Dependency Map](#18-module-dependency-map)

---

## 1. Architecture Overview

The application follows a strict **one-way data-flow pipeline**. Nothing renders directly; everything goes through the scene graph:

```
API / Provider
     ↓
  DataEngine          loads bars, volume, indicators, events into state
     ↓
  LayoutEngine        computes scene: panes, visible windows, price/time scales
     ↓
  Renderer            draws all layers using the scene
     ↑
  InteractionEngine   updates state on pointer input → triggers re-render
```

### Core files

| File | Role |
|------|------|
| `src/core/Engine.js` | Orchestrator — wires every subsystem, exposes public API |
| `src/core/State.js` | Shared mutable state object (bars, zoom, cursor, signals, …) |
| `src/layout/LayoutEngine.js` | Computes `scene` — pane rects, visible bar window, scales |
| `src/render/Renderer.js` | Iterates layers and calls each one's `draw(ctx, scene)` |
| `src/interaction/InteractionEngine.js` | Pan, zoom, drag, right-click context menu |
| `src/main.js` | Bootstrap — binds DOM, starts engine, populates symbol dropdown |

**Rules:** Never collapse layers into one file. Never introduce a framework. All computation is pure-function; DOM touches only happen in `Engine.js` and UI classes.

---

## 2. Data Layer

### 2.1 DataEngine (`src/data/DataEngine.js`)

Wraps any **provider function** (async `() → { bars, volume, macd, markers, events, positions }`). Stores the full dataset in `_all` and exposes a windowed view to state for incremental rendering.

### 2.2 LiveProvider (`src/data/LiveProvider.js`)

Connects to the REST API. Key behaviours:

- **Adaptive chunking:** `daysBack ≤ 30` → 3-day windows; `≤ 90` → 7-day; `≤ 365` → 14-day; `> 365` → 21-day. Maximises bar count while staying inside the API's 10,000 bar-per-request limit.
- **`fetchSymbols()`** — returns the full symbol list from `/symbols`.
- **`fetchAllAvailable(symbol, progressCb)`** — walks backwards from today in 21-day windows until the API returns empty data. Maximum 60 windows (~3.4 years of history).
- **`fetchMultiSymbol(symbols[], daysBack, progressCb)`** — parallel `Promise.allSettled` across multiple symbols; graceful per-symbol failure.
- **`makeOptimizerProvider(symbol, opts)`** — convenience wrapper that pre-fetches maximum history for optimizer use, with a progress callback.

### 2.3 Providers (`src/data/Providers.js`)

Static mock/sample providers used for offline/dev mode. Loaded as fallback when the live API is unreachable.

### 2.4 StreamController & WebSocketStream (`src/data/StreamController.js`, `src/data/WebSocketStream.js`)

Manage a live WebSocket feed. `StreamController` buffers incoming ticks, merges them into the current bar or opens a new bar, then calls `engine.render()`. The stream can be toggled on/off via the **Stream** button.

### 2.5 Aggregator (`src/util/Aggregator.js`)

Resamples 1-minute bars into any timeframe (5m, 15m, 1h, 4h, 1d) using close-aggregation OHLCV logic. `tfToMinutes(tf)` converts a timeframe string to a minute count.

---

## 3. Chart Rendering

### 3.1 Renderer (`src/render/Renderer.js`)

Iterates an ordered list of layer instances and calls `draw(ctx, scene)` on each. Stores `state._scene` after each layout pass. DPR-aware — all coordinates are in physical pixels.

### 3.2 Render Layers (`src/render/layers/`)

Each layer is a self-contained module with a single `draw()` export.

| Layer | What it draws |
|-------|--------------|
| `GridLayer.js` | Background grid lines (horizontal price levels, vertical time guides) |
| `CandlesLayer.js` | OHLC candles or bars — bull/bear coloured, body + wicks |
| `AxisLayer.js` | Price axis (right), time axis (bottom), tick labels |
| `MACDLayer.js` | MACD pane — histogram bars, MACD line, signal line |
| `OverlayLayer.js` | EMA/SMA overlays drawn directly on the price pane |
| `CrosshairLayer.js` | Cursor crosshair lines and price/time bubble labels |
| `HUDLayer.js` | Heads-up display — OHLCV, indicator values at cursor position |
| `MarkersLayer.js` | Entry/exit signal triangles + trade labels |
| `DrawingLayer.js` | User-drawn horizontal lines and trend lines |
| `PositionsLayer.js` | Open position bands (entry price ± stop/TP) |
| `PnLLayer.js` | Cumulative P&L curve overlaid on the price pane |
| `DecisionLaneLayer.js` | Visual "decision lane" — colour-coded zone between two EMA lines |

---

## 4. Interaction & Drawing Tools

### InteractionEngine (`src/interaction/InteractionEngine.js`)

Handles all pointer events on the canvas:

- **Pan** — click-drag left/right to scroll through history
- **Zoom** — scroll wheel (or pinch on touch) scales the time axis  
- **Zoom buttons** — `zoomIn()` / `zoomOut()` apply a fixed 0.82×/1.22× factor
- **Reset view** — fits all loaded bars into the viewport
- **Right-click context menu** — "Auto-place signals", "Clear signals", drawing tool shortcuts
- **Risk mode click** — when Risk Mode is active, a click on the price pane places a risk block at that price level

### Drawing Tools

Activated by calling `engine.setDrawingMode(mode)`:

| Mode | Result |
|------|--------|
| `"hline"` | Horizontal price line — drag to place, persists across redraws |
| `"trendline"` | Two-point trend line |
| `clearDrawings()` | Removes all user drawings |

### UndoStack (`src/interaction/UndoStack.js`)

Lightweight undo/redo for drawing operations. `Ctrl+Z` reverts the last drawing action; `Ctrl+Y` or `Ctrl+Shift+Z` reapplies.

---

## 5. Signal Engine

**File:** `src/signals/SignalEngine.js`

The Signal Engine evaluates configurable rule sets against bar data and simulates trade outcomes.

### 5.1 Indicator Helpers (exported)

| Function | Description |
|----------|-------------|
| `calcEMA(prices, period)` | SMA-seeded exponential moving average |
| `calcATR(bars, period)` | Average True Range (Wilder's method) |
| `calcRSI(prices, period)` | Relative Strength Index |
| `calcADX(bars, period)` | Average Directional Index (trend strength) |
| `calcMACD(prices, fast, slow, sig)` | Returns `{macd[], signal[], hist[]}` |

### 5.2 Condition IDs

Each condition is identified by a string ID and a `params` object. All conditions support `enabled: true|false`.

**Long conditions:**

| ID | Description |
|----|-------------|
| `ema_cross_up` | Fast EMA crosses above slow EMA |
| `ema_above_slow` | Fast EMA is currently above slow EMA |
| `ema_slope_up` | EMA slope is positive over `lookback` bars |
| `price_above_ema` | Close above a single EMA |
| `macd_hist_pos` | MACD histogram is positive |
| `macd_above_signal` | MACD line above signal line |
| `rsi_in_zone` | RSI between `min` and `max` |
| `rsi_oversold` | RSI below oversold threshold |
| `price_above_vwap` | Close above VWAP |
| `higher_high` | Current high exceeds the previous swing high |
| `volume_spike` | Volume ≥ `multiplier` × average volume |
| `adx_trending` | ADX ≥ threshold (trend strength gate) |

**Short conditions** mirror the above with directionally-flipped equivalents (`ema_cross_down`, `rsi_overbought`, `lower_low`, etc.)

**Gate conditions** (injected by optimizer only, not tested standalone):

| ID | Description |
|----|-------------|
| `regime_tradeable` | Passes only when the current regime supports the trade direction |
| `forecast_clears_fees` | ATR-based projection must exceed fees × R:R × safety margin |

### 5.3 Strategy Schema

```jsonc
{
  "schema_version": "1.0",
  "meta": { "name": "", "symbol": "", "timeframe": "", "created": "", "notes": "" },
  "entry": {
    "direction": "long",          // "long" | "short" | "both"
    "logic": "AND",               // "AND" | "OR"  — how conditions combine
    "confirm_bars": 1,            // bars to wait for entry confirmation
    "conditions": [ /* condition objects */ ]
  },
  "exit": {
    "stop_loss":   { "type": "atr", "params": { "period": 14, "multiplier": 1.5 } },
    "take_profit": { "type": "rr", "ratio": 2.0 },
    "max_bars":    48             // force-exit after N bars if TP/SL not hit
  },
  "risk": {
    "account_size":         1000,
    "risk_per_trade_pct":   1.0,
    "max_open_positions":   1,
    "max_drawdown_pct":     10.0
  },
  "fees": { "exchange": "Kraken Pro", "entry_pct": 0.40, "exit_pct": 0.25 }
}
```

### 5.4 `runSignalScan(bars, strategy, overrides?, qualityOpts?)`

The core scanning loop:

1. Computes all indicator arrays once (EMA, RSI, MACD, ATR, ADX, VWAP, volume moving average)
2. Evaluates each bar's condition set using `logic: AND | OR`
3. Simulates trades: ATR-based or pct-based stop, R:R take-profit, max-bars forced exit
4. Applies fee drag to every trade P&L
5. Returns `{ signals[], trades[], stats }` where stats includes: `total`, `wins`, `losses`, `win_rate`, `profit_factor`, `net_pnl_usd`, `max_drawdown_pct`, `avg_rr_achieved`, `sharpe`

**Optional 4th arg `qualityOpts`:** When `{ enabled: true, minSQS, feeRtPct, rrRatio, edgeCache }` is provided, each signal is additionally gated through the SQS engine before a trade is opened. Trades that fail the SQS threshold are skipped.

### 5.5 `defaultStrategy(symbol, timeframe)`

Returns a ready-to-use strategy object pre-loaded with EMA 9/21 cross + MACD histogram + RSI zone conditions, Kraken Pro fee defaults, and 1% risk per trade.

### 5.6 `exportStrategyJSON(strategy)`

Serialises the strategy object to a formatted JSON string suitable for clipboard copy or download.

---

## 6. Market Regime Engine

**File:** `src/signals/RegimeEngine.js`

Classifies every bar into one of **five mutually-exclusive regimes** using a multi-factor institutional model. This is a pure computation module with no DOM dependencies.

### 6.1 Regime Labels

| Regime | Criteria |
|--------|----------|
| `trending_bull` | ADX ≥ threshold **AND** EMA slope positive **AND** ATR within normal range |
| `trending_bear` | ADX ≥ threshold **AND** EMA slope negative **AND** ATR within normal range |
| `breakout_pending` | ATR percentile < 25th (compression — energy coiling before move) |
| `volatile_chaos` | ATR percentile > 88th without ADX-confirmed directionality |
| `ranging_tight` | Everything else — low ADX, no compression, no spike |

**Priority order:** chaos → compression → trending → ranging (first match wins).

### 6.2 Configuration Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `adxPeriod` | 14 | ADX lookback period |
| `adxTrendThreshold` | 22 | ADX value above which market is "trending" |
| `emaSlopePeriod` | 21 | EMA used for slope direction |
| `emaSlopeLookback` | 4 | Bars of slope to check |
| `atrPeriod` | 14 | ATR lookback |
| `atrLookback` | 100 | Rolling window for ATR percentile ranking |
| `compressionPct` | 25 | ATR below this percentile → `breakout_pending` |
| `chaosPct` | 88 | ATR above this percentile → `volatile_chaos` |

### 6.3 Exported Functions

| Function | Returns |
|----------|---------|
| `classifyRegimes(bars, opts?)` | `{ regimes[], adx[], atrPct[], bbWidthPct[], emaBull[] }` |
| `isTradeable(regime, direction)` | Boolean — whether the regime supports a trade in that direction |
| `regimeSummary(regimes, lookback)` | Count of each regime type over the last N bars |
| `regimeStreak(regimes)` | Current consecutive-bar count in the current regime |

---

## 7. Signal Quality Score (SQS)

**File:** `src/signals/SignalQuality.js`

Every signal that passes entry conditions is scored **0–100** across four independent components. Trades are only taken when `SQS ≥ minSQS` (default 55).

### 7.1 Component Breakdown

#### Component 1 — Volatility Adequacy (0–30 pts)

Is the current ATR large enough to overcome fees and still be profitable?

$$\text{score} = \min\!\left(\frac{\text{ATR\%}}{\text{fees} \times R\!:\!R \times \text{margin}},\; 1\right) \times 30$$

#### Component 2 — Regime Alignment (0–25 pts)

| Regime | Long pts | Short pts |
|--------|----------|-----------|
| `trending_bull` | 25 | 0 |
| `trending_bear` | 0 | 25 |
| `breakout_pending` | 15 | 15 |
| `ranging_tight` | 0 + hard_block | 0 + hard_block |
| `volatile_chaos` | 0 + hard_block | 0 + hard_block |

A `hard_block` caps the total SQS at 40 regardless of other component scores, ensuring nothing trades in unfavourable regimes.

#### Component 3 — Historical Conditional Edge (0–25 pts)

Bayesian win-rate posterior over the trade history for the same `(direction, regime, conditionSet)` key:

$$P_{\text{posterior}} = \frac{\text{wins} + \text{prior\_wins}}{\text{total} + \text{prior\_total}}$$

Prior is weak (3 wins / 6 total) so 8+ observations override it. Score = `posterior × 25`.

#### Component 4 — Multi-Timeframe Confluence (0–20 pts)

EMA slope on a 4× higher timeframe:

- Agrees with signal direction → 20 pts
- Disagrees → 0 pts
- No HTF data available → neutral 10 pts

### 7.2 EdgeCache

```javascript
const cache = new EdgeCache();
cache.record("long", "trending_bull", ["ema_cross_up","rsi_in_zone"], win=true);
const edge = cache.query("long", "trending_bull", ["ema_cross_up","rsi_in_zone"]);
// → { wins, total, posterior }
```

`globalEdgeCache` is a module-level singleton shared across all scan runs in the same browser session.

### 7.3 `computeSQS(bars, barIdx, direction, conditionIds, regimeResult, opts)`

Master entry point. Returns:

```javascript
{
  total: 78,           // 0–100
  passes: true,        // total >= minSQS
  components: {
    volatility:  { score: 28, atrPct: 0.82, required: 0.43 },
    regime:      { score: 25, hard_block: false, regime: "trending_bull" },
    edge:        { score: 15, wins: 6, total: 10, posterior: 0.6 },
    mtf:         { score: 10, aligned: null }
  },
  hard_block: false
}
```

---

## 8. Strategy Optimizer

**File:** `src/signals/SignalOptimizer.js`

A multi-pass institutional-grade optimizer. Runs **asynchronously on the main thread**, yielding to the browser every 80 combinations so the UI stays responsive and the progress bar updates in real time.

### 8.1 Five-Pass Architecture

#### Pass 0 — Condition Selection

- Tests every condition ID individually across all parameter variants
- Finds the **top 8** single conditions per direction by score
- Sweeps all 2-condition AND/OR combos from the top 8
- Sweeps all 3-condition combos from the top 4
- Selects the best condition set

#### Pass 1 — Entry Parameter Refinement

- Full cartesian product of all parameter variants if ≤ 600 combinations
- Otherwise **OFAT** (One Factor At A Time) — varies one condition's params while holding others fixed
- Locks in the best entry configuration (EMA pairs, RSI levels/zones/period, MACD config, price EMA period, volume multiplier)

#### Pass 2 — Exit Parameter Sweep

- Sweeps `ATR multiplier × ATR period + pct stop × R:R ratio × max_bars`
- ~2,700 combinations; yields every 80 so the browser never freezes
- Locks in the best stop/TP/timeout configuration

#### Pass 3 — Direction & Logic Global Sweep

- Tests both directions (`long` / `short`) and both logics (`AND` / `OR`)
- Uses the best condition set + entry params from passes 0–2

#### Pass 3b — Gate Injection

- Takes the top-5 strategies found so far
- Injects each of 6 gate variants (3 × `regime_tradeable` at ADX 20/22/25, 3 × `forecast_clears_fees` at different margin levels)
- Keeps a gated version only if it still produces `≥ minTrades` trades

#### Pass 4 — Walk-Forward OOS Validation

- Splits data 70% train / 30% out-of-sample
- Tests top-10 in-sample strategies on the OOS window
- Promotes strategies that survive OOS validation (OOS P&L > 0, sufficient trade count)
- Results are tagged with `oosPass: true|false`

#### Pass 5 — SQS Threshold Sweep

- Sweeps `minSQS` thresholds: `[0, 35, 40, 45, 50, 55, 60, 65, 70]`
- Combined score = 60% in-sample + 40% OOS
- Reports `recommendedMinSQS` — the threshold that maximises combined Sharpe

### 8.2 Adaptive Expansion

If no profitable strategy (PF > 1.0) is found after a full pass cycle:

1. Relaxes minimum trade count: **6 → 4 → 3**
2. Expands parameter ranges from `"standard"` to `"expanded"` (wider EMA pairs, more RSI levels, etc.)
3. Repeats all passes — first profitable result stops the search

### 8.3 Progress & Cancellation

- `progressCb({ phase, tested, total })` fires every CHUNK (80) combinations
- `AbortController` / `AbortSignal` — calling `engine._optimizerAbort.abort()` cancels cleanly between chunks
- The cancel button in the UI calls this automatically

### 8.4 Result Shape

```javascript
{
  best: strategy,         // best strategy object
  topResults: [           // top-N deduped results
    {
      strategy, stats,
      score,              // composite score
      pass: 2,            // which pass found this
      oosPass: true,      // survived walk-forward?
      oos: { stats, sharpe, trades }
    }
  ],
  passStats: {
    p0Combos, p1Combos, p2Combos, p3Combos,
    totalCombos, elapsedMs,
    foundProfitable,
    expandedSearch,
    recommendedMinSQS,    // from Pass 5
    sqsSweepResults,
    oosValidCount,
    aborted
  }
}
```

### 8.5 Parameter Search Spaces

| Parameter | Standard | Expanded |
|-----------|----------|----------|
| EMA pairs | 19 pairs | 30 pairs |
| Price EMA periods | 8 values | 8 values |
| RSI zones | 14 zone combos | 14 zone combos |
| RSI oversold levels | 7 | 7 |
| RSI periods | 4 | 4 |
| ATR multipliers | 9 | 9 |
| R:R ratios | 9 | 9 |
| Max bars | 7 | 7 |
| Volume multipliers | 7 | 7 |

---

## 9. Backtester

**File:** `src/backtest/Backtester.js`

Runs a full simulation over the loaded bars using the current strategy. Called via `engine.runBacktest()` or the **Backtest** toolbar button.

- Applies all entry/exit conditions and fee calculations
- Produces a full trade list with entry/exit times, prices, P&L, hold duration
- Passes results to `showStats()` for the detailed stats panel

---

## 10. Streaming & Live Data

**File:** `src/data/StreamController.js`, `src/data/WebSocketStream.js`

- `WebSocketStream` opens a WebSocket to the API and emits tick events
- `StreamController` consumes ticks, builds or updates the current bar (OHLCV aggregation)
- New/updated bars are merged into state, the live tape DOM is updated, and `render()` is called
- Toggle via `engine.toggleStream()` / the **Stream** button
- A **live tape** display shows the last N tick prices in real time

---

## 11. Alerts Engine

**File:** `src/alerts/AlertEngine.js`

Price-level and condition-based alerts.

- **Add alert** — set a price level and trigger direction (crosses above / crosses below)
- **Alert list** — shows all active and triggered alerts with time of trigger
- **Browser notifications** — fires a `Notification` API notification when triggered (requires permission)
- Alerts persist in `localStorage` across page reloads
- Accessed via `engine.showAlerts()` / the **Alerts** button

---

## 12. Trade Journal

**File:** `src/journal/Journal.js`

A manual trade journal attached to the chart session.

- Log trades with entry/exit price, size, direction, notes, and linked chart screenshot
- Filter by symbol, date range, direction, outcome (win/loss)
- Calculates running P&L statistics across journaled trades
- Accessed via `engine.showJournal()` / the **Journal** button

---

## 13. Multi-Timeframe Panel

**File:** `src/ui/MTFPanel.js`

Displays indicator values (EMA slope, RSI, MACD, regime) across multiple timeframes (15m, 1h, 4h, 1d) for the current symbol. Helps with confluence-based entry decisions. Toggled via `engine.toggleMTF()`.

---

## 14. Risk Calculator

**File:** `src/ui/RiskCalculator.js`

An interactive position-sizing calculator.

- Input: account size, risk %, entry price, stop price
- Output: position size (units + USD), potential loss, R:R ratio
- **Risk Mode** — click any price on the chart to set the stop level automatically; the calculator updates in real time
- Toggled via `engine.toggleRiskMode()` / the **Risk** button
- Risk block visualisation painted on the price pane by `PositionsLayer`

---

## 15. Watchlist

**File:** `src/ui/Watchlist.js`

Left sidebar displaying all available symbols.

- Fetches the full symbol list from `/symbols` on load
- Each row shows the **symbol name + exchange**, a **48×22 sparkline** of recent price action, and the **last price**
- Prices update every 30 seconds via polling
- Clicking a row calls `engine.loadSymbol(symbol)` to switch the chart

---

## 16. Replay Controller

**File:** `src/replay/ReplayController.js`

Bar-by-bar chart replay for trade study.

- **Toggle** `engine.replay.toggle()` — starts/pauses replay from the beginning (or current position)
- **Step** `engine.replay.step()` — advances one bar at a time
- Signals and trades are re-evaluated at each step so you can watch the strategy fire in real time
- Progress shown in the status bar

---

## 17. UI Panels & Controls

### Toolbar Buttons

| Button ID | Action |
|-----------|--------|
| `symbolSelect` | Symbol dropdown — triggers `engine.loadSymbol()` |
| `daysSelect` | History depth dropdown — triggers reload |
| `ivGroup [data-iv]` | Timeframe selector — calls `engine.setTimeframe(iv)` |
| `zoomIn` / `zoomOut` | ±20% time zoom |
| `resetView` | Fit all bars in viewport |
| `statsBtn` | Open trade stats panel |
| `exportBtn` | Export strategy + bars as AI-ready JSON |
| `backtestBtn` | Run backtest on current strategy |
| `journalBtn` | Open trade journal |
| `alertsBtn` | Open alerts panel |
| `streamBtn` | Toggle live feed |
| `replayToggle` | Start/pause replay |
| `stepForward` | Step one bar in replay |
| `hlineBtn` | Activate horizontal line drawing mode |
| `trendlineBtn` | Activate trend line drawing mode |
| `clearDrawingsBtn` | Remove all drawings |
| `hudToggle` | Cycle HUD: compact → expanded → hidden |

### Stats Panel (`engine.showStats()`)

Rendered as an overlay panel. Displays:

- Total trades, wins, losses, win rate
- Profit factor, net P&L USD
- Average P&L, best trade, worst trade
- Max drawdown %
- Average hold time, average win hold, average loss hold
- Last 30 individual trades with date, direction, entry→exit, P&L

### Optimizer Panel (`SignalRuleEditor`)

**File:** `src/signals/SignalRuleEditor.js`

- Visual editor for all strategy parameters (conditions, logic, direction, exit config, fees, risk)
- **Optimize button** — triggers the 5-pass optimizer
- **Progress bar** — animated stripe, shows current pass (0-5) as step dots; updates every 80 combinations
- **Cancel button** — aborts the optimizer cleanly via `AbortController`
- **Result cards** — top-N strategies displayed with score, stats, OOS badge (✓ OOS / ✗ OOS), and one-click apply
- **OOS count badge** in the footer shows how many results survived walk-forward validation
- **SQS recommendation** — shows `SQS≥N` from Pass 5 when a meaningful threshold is found

---

## 18. Module Dependency Map

```
main.js
 ├── core/Engine.js
 │    ├── core/State.js
 │    ├── data/DataEngine.js
 │    ├── layout/LayoutEngine.js
 │    ├── render/Renderer.js
 │    │    └── render/layers/*
 │    ├── interaction/InteractionEngine.js
 │    │    └── interaction/UndoStack.js
 │    ├── replay/ReplayController.js
 │    ├── export/LabelExporter.js
 │    ├── signals/SignalEngine.js          ← indicator helpers + runSignalScan
 │    ├── signals/SignalRuleEditor.js      ← optimizer UI
 │    ├── signals/SignalOptimizer.js       ← 5-pass optimizer
 │    │    ├── signals/RegimeEngine.js     ← regime classifier
 │    │    └── signals/SignalQuality.js    ← SQS engine
 │    ├── signals/StrategyAnalyzer.js
 │    ├── backtest/Backtester.js
 │    ├── alerts/AlertEngine.js
 │    ├── journal/Journal.js
 │    ├── data/LiveProvider.js             ← REST API client + adaptive fetch
 │    ├── data/StreamController.js
 │    ├── data/WebSocketStream.js
 │    ├── ui/MTFPanel.js
 │    ├── ui/RiskCalculator.js
 │    └── util/Aggregator.js
 ├── data/Providers.js                     ← mock/offline provider
 ├── data/LiveProvider.js (fetchSymbols)
 └── ui/Watchlist.js
 
util/indicators.js  ← leaf module: EMA, ATR, ADX, RSI, Bollinger, VWAP
                       imported by RegimeEngine + SignalQuality (breaks circular deps)
```

---

## Key Formulas Reference

### Fee-Clearance Gate

A trade is only considered viable when the projected ATR-derived move can overcome the round-trip fee cost:

$$\frac{\text{ATR}}{\text{price}} \times 100 \;\geq\; \text{fee\_rt\_pct} \times R\!:\!R \times \text{margin}$$

Default: `0.65% × 2.0 × 2.0 = 2.6%` — ATR must represent at least 2.6% of price.

### Optimizer Score Function

$$\text{score} = \begin{cases} -\infty & \text{if trades} < \text{minTrades} \\ \text{Sharpe} \times \ln(1 + \text{trades}) \times \ln(1 + \text{PF}) & \text{otherwise} \end{cases}$$

Trades below the minimum threshold are immediately rejected. The log multipliers reward larger sample sizes and higher profit factors while preventing overfitting to small trade counts.

### Kelly Fraction

Used in `SignalQuality.js` for optional position-sizing guidance:

$$f^* = \frac{p \cdot (R+1) - 1}{R}$$

where $p$ = Bayesian win-rate posterior, $R$ = R:R ratio. Output is clamped to $[0, 0.25]$ (quarter-Kelly maximum).
