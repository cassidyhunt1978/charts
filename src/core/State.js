export function createState() {
  return {
    symbol: "MOCK",
    timeframe: "1m",
    tfMinutes: 1,           // numeric minutes (for aggregator)

    bars: [],
    rawBars: [],            // original 1-min bars before aggregation
    macd: [],
    volume: [],
    rawVolume: [],          // original 1-min volume before aggregation
    ema9:  [],
    ema21: [],
    rsi:   [],              // RSI(14) aligned with bars[]
    bb:    null,            // { upper[], mid[], lower[] } aligned with bars[]
    vwap:  [],              // VWAP aligned with bars[]

    _dataLimits: { minT: null, maxT: null },

    // Labels
    markers: [],
    labelEdits: [],

    // Positions
    positions: [],

    // Events (lane strip)
    events: [],

    xDomain: [0, 0],
    cursorT: null,
    cursorX: null,
    cursorY: null,

    _panes: null,
    _priceScale: null,

    dragging: {
      active: false,
      type: null,
      id: null,
      start: null
    },

    selectedMarkerId:  null,
    selectedPositionId: null,
    selectedDrawingId:  null,

    // ── drawings ──────────────────────────────────────────────
    drawings: [],           // [{id,type,…}] — hlines & trendlines

    // ── drawing mode ──────────────────────────────────────────
    drawingMode: null,      // null | "hline" | "trendline"
    _drawingInProgress: null,

    // ── indicator toggles ─────────────────────────────────────
    indicators: {
      rsi:  false,
      bb:   false,
      vwap: false,
      vpvr: false,    // Volume Profile Visible Range
      smc:  false,    // Smart Money Concepts
    },

    // ── Volume Profile settings ────────────────────────────────
    vpvrRows: 120,

    // ── Risk / position size calculator ───────────────────────
    riskMode: false,
    risk: {
      step:        0,
      stopPrice:   null,
      targetPrice: null,
      accountSize: 10000,
      riskPct:     1.0,
    },

    // ── Live tape (WebSocket ticks) ───────────────────────────
    liveTape: [],

    // ── MTF panel visibility ──────────────────────────────────
    mtfVisible: false,

    // crosshair price (screen px → price, set by CrosshairLayer) ──────────
    crosshairPrice: null,

    // ── alerts ────────────────────────────────────────────────
    alerts: [],
    // ── computed signals (SignalEngine output) ───────────────────────────
    computedSignals: [],   // [{id,t,price,direction,stop,target,rr,qty,...}]
    computedTrades:  [],   // [{entryT,exitT,entryPrice,exitPrice,pnlUSD,...}]
    // ── streaming ────────────────────────────────────────────
    streaming: false,

    replay: {
      enabled: false,
      index: null,
      playing: false,
      playMs: 120,
      lastTick: 0,
      labelLock: true,
    },

    settings: {
      feeBps: 8,
      spreadBps: 4,
      slippageBps: 2,
      snapPriceMode: "OHLC",
    },

    limits: {
      minSpanMs: 5 * 60 * 1000,
      maxSpanMs: 30 * 24 * 60 * 60 * 1000,
      leftLoadThresholdPx: 140,
    },
  };
}
