import { detectSignals, computeEmas }            from "../signals/SignalDetector.js";
import { computeRSI, computeBollinger, computeVWAP } from "../util/indicators.js";
import { resample, resampleVolume, tfToMinutes }     from "../util/Aggregator.js";
import { _computeMacd }                              from "./LiveProvider.js";

export class DataEngine {
  constructor(provider, state) {
    this.provider = provider;
    this.state = state;

    // Optional internal full-store for incremental load demo
    this._all = null; // {bars, macd, volume, markers, events, positions}
    this._loadedRange = { startIdx: 0, endIdx: -1 };
  }

  async loadInitial() {
    const d = await this.provider();

    this._all = {
      bars: d.bars ?? [],
      macd: d.macd ?? [],
      volume: d.volume ?? [],
      markers: d.markers ?? [],
      events: d.events ?? [],
      positions: d.positions ?? []
    };

    const n = this._all.bars.length;
    if (!n) return;

    // Store 1-min originals for TF aggregation
    this._all.rawBars   = this._all.bars.slice();
    this._all.rawVolume = this._all.volume.slice();
    this.state.rawBars   = this._all.rawBars;
    this.state.rawVolume = this._all.rawVolume;

    // Start by revealing only the most recent chunk; left-load will prepend older.
    const initial = Math.min(2500, n);
    this._loadedRange.endIdx = n - 1;
    this._loadedRange.startIdx = Math.max(0, n - initial);

    this._syncLoadedToState();

    // Compute EMAs
    const emas = computeEmas(this._all.bars);
    this._all.ema9  = emas.ema9;
    this._all.ema21 = emas.ema21;

    // Compute indicators on full dataset
    this._all.rsi  = computeRSI(this._all.bars);
    this._all.bb   = computeBollinger(this._all.bars);
    this._all.vwap = computeVWAP(this._all.bars, this._all.volume);

    // Re-slice EMAs + indicators into state
    const s0 = this._loadedRange.startIdx;
    const e0 = this._loadedRange.endIdx;
    this.state.ema9  = this._all.ema9.slice(s0, e0 + 1);
    this.state.ema21 = this._all.ema21.slice(s0, e0 + 1);
    this._syncIndicatorsToState();

    const autoEvents = detectSignals(
      this._all.bars,
      this._all.macd,
      this._all.volume
    );
    const existingIds = new Set(this.state.events.map(e => e.id));
    const newEvents   = autoEvents.filter(e => !existingIds.has(e.id));
    this.state.events = [...this.state.events, ...newEvents];

    // Set initial view domain to last ~900 bars (or less)
    const m = this.state.bars.length;
    const lookback = Math.min(900, m);
    this.state.xDomain = [this.state.bars[m - lookback].t, this.state.bars[m - 1].t];

    this.state._dataLimits.minT = this._all.bars[0].t;
    this.state._dataLimits.maxT = this._all.bars[n - 1].t;
  }

  /** Switch timeframe: resample raw 1-min bars and recompute all indicators */
  applyTimeframe(tfMin) {
    if (!this._all?.rawBars?.length) return;
    this.state.tfMinutes = tfMin;

    const bars   = tfMin <= 1
      ? this._all.rawBars.slice()
      : resample(this._all.rawBars, tfMin);
    const volume = tfMin <= 1
      ? this._all.rawVolume.slice()
      : resampleVolume(this._all.rawVolume, tfMin);

    this._all.bars   = bars;
    this._all.volume = volume;

    const n = bars.length;
    this._loadedRange.endIdx   = n - 1;
    this._loadedRange.startIdx = Math.max(0, n - 2500);

    // Recompute all derived arrays
    const emas = computeEmas(bars);
    this._all.ema9  = emas.ema9;
    this._all.ema21 = emas.ema21;
    this._all.rsi   = computeRSI(bars);
    this._all.bb    = computeBollinger(bars);
    this._all.vwap  = computeVWAP(bars, volume);
    // Recompute MACD from the resampled bars so the histogram stays intact
    this._all.macd  = _computeMacd(bars);

    this._syncLoadedToState();

    const m = this.state.bars.length;
    const lookback = Math.min(900, m);
    this.state.xDomain = [this.state.bars[m - lookback].t, this.state.bars[m - 1].t];
    this.state._dataLimits.minT = bars[0].t;
    this.state._dataLimits.maxT = bars[n - 1].t;
  }

  _syncIndicatorsToState() {
    const a = this._all;
    const s = this._loadedRange.startIdx;
    const e = this._loadedRange.endIdx;
    if (a.rsi)  this.state.rsi  = a.rsi.slice(s, e + 1);
    if (a.bb)   this.state.bb   = {
      upper: a.bb.upper.slice(s, e + 1),
      mid:   a.bb.mid.slice(s, e + 1),
      lower: a.bb.lower.slice(s, e + 1),
    };
    if (a.vwap) this.state.vwap = a.vwap.slice(s, e + 1);
  }

  _syncLoadedToState() {
    const a = this._all;
    const s = this._loadedRange.startIdx;
    const e = this._loadedRange.endIdx;

    this.state.bars   = a.bars.slice(s, e + 1);
    this.state.macd   = a.macd.slice(s, e + 1);
    this.state.volume = a.volume.slice(s, e + 1);
    if (a.ema9)  this.state.ema9  = a.ema9.slice(s, e + 1);
    if (a.ema21) this.state.ema21 = a.ema21.slice(s, e + 1);
    this._syncIndicatorsToState();

    this.state.markers   = (a.markers ?? []).map(m => ({ pane: "lane", ...m }));
    this.state.events    = a.events ?? [];
    this.state.positions = a.positions ?? [];
  }

  canLoadOlder() {
    return this._all && this._loadedRange.startIdx > 0;
  }

  loadOlderChunk(count = 1500) {
    if (!this.canLoadOlder()) return false;
    const prevStart = this._loadedRange.startIdx;
    this._loadedRange.startIdx = Math.max(0, prevStart - count);
    this._syncLoadedToState();
    return true;
  }
}
