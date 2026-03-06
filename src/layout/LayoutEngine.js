import { bisectByT } from "../util/bisect.js";
import { clamp } from "../util/math.js";

export class LayoutEngine {
  constructor(state) {
    this.state = state;
  }

  computeScene(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    const pad        = 10;
    const RIGHT_AXIS = 62;

    const showRSI = this.state.indicators?.rsi;

    // Adaptive pane heights
    const laneH  = Math.max(40, Math.floor(H * 0.09));
    const macdH  = Math.floor(H * (showRSI ? 0.18 : 0.22));
    const rsiH   = showRSI ? Math.floor(H * 0.13) : 0;
    const priceH = H - laneH - macdH - rsiH - pad * (showRSI ? 5 : 4);

    let y = pad;
    const panes = {
      lane:  { x: pad, y, w: W - pad - RIGHT_AXIS, h: laneH },
    };
    y += laneH + pad;
    panes.price = { x: pad, y, w: W - pad - RIGHT_AXIS, h: priceH };
    y += priceH + pad;
    if (showRSI) {
      panes.rsi = { x: pad, y, w: W - pad - RIGHT_AXIS, h: rsiH };
      y += rsiH + pad;
    }
    panes.macd = { x: pad, y, w: W - pad - RIGHT_AXIS, h: macdH };

    // Clamp xDomain span
    let [t0, t1] = this.state.xDomain;
    const span = t1 - t0;

    const minSpan = this.state.limits.minSpanMs;
    const maxSpan = this.state.limits.maxSpanMs;
    const clampedSpan = clamp(span, minSpan, maxSpan);

    if (clampedSpan !== span) {
      const mid = (t0 + t1) * 0.5;
      t0 = mid - clampedSpan * 0.5;
      t1 = mid + clampedSpan * 0.5;
      this.state.xDomain = [t0, t1];
    }

    // Clamp pan so the view can never scroll completely off the data.
    // Allow a small margin (15% of the current span) past each edge so the
    // first/last candle can comfortably sit near the centre of the screen.
    const barsAll = this.state.bars;

    // Guard: no data yet (mid-reload) — return a minimal scene so renders don't crash
    if (barsAll.length === 0) {
      return {
        W, H, rightAxisW: 62, panes,
        xDomain: this.state.xDomain,
        bars: [], macd: [], volume: [],
        markers: this.state.markers, events: this.state.events, positions: this.state.positions,
        cursorBar: null, state: this.state,
      };
    }

    if (barsAll.length >= 2) {
      const currentSpan = t1 - t0;
      const margin = currentSpan * 0.15;
      const dataStart = barsAll[0].t;
      const dataEnd   = barsAll[barsAll.length - 1].t;

      // Can't pan so far right that all data is past the left edge
      const t0Max = dataEnd + margin;
      // Can't pan so far left that all data is past the right edge
      const t1Min = dataStart - margin;

      if (t0 > t0Max) {
        t0 = t0Max;
        t1 = t0 + currentSpan;
        this.state.xDomain = [t0, t1];
      } else if (t1 < t1Min) {
        t1 = t1Min;
        t0 = t1 - currentSpan;
        this.state.xDomain = [t0, t1];
      }
    }

    // Apply replay limit (hide future)
    let barsMaxIndex = barsAll.length - 1;

    if (this.state.replay.enabled && this.state.replay.index != null) {
      barsMaxIndex = clamp(this.state.replay.index, 0, barsAll.length - 1);
      // Also clamp domain max
      const maxT = barsAll[barsMaxIndex].t;
      if (this.state.xDomain[1] > maxT) {
        const currentSpan = this.state.xDomain[1] - this.state.xDomain[0];
        this.state.xDomain = [maxT - currentSpan, maxT];
        t0 = this.state.xDomain[0];
        t1 = this.state.xDomain[1];
      }
    }

    // Windowing: compute visible indices by bisect (fast)
    const lo = clamp(bisectByT(barsAll, t0), 0, barsMaxIndex);
    const hi = clamp(bisectByT(barsAll, t1), 0, barsMaxIndex);

    // Add small buffer for smoother rendering
    const buf = 50;
    const i0 = clamp(lo - buf, 0, barsMaxIndex);
    const i1 = clamp(hi + buf, 0, barsMaxIndex);

    const bars = barsAll.slice(i0, i1 + 1);

    // MACD/volume aligned by time; window with same t0/t1
    // Guard: if array is empty or first entry is null (cleared after TF change), treat as empty.
    const macdAll = (this.state.macd?.length && this.state.macd[0] != null) ? this.state.macd : [];
    const volAll  = (this.state.volume?.length && this.state.volume[0] != null) ? this.state.volume : [];

    const macdLo = macdAll.length ? clamp(bisectByT(macdAll, t0), 0, macdAll.length - 1) : 0;
    const macdHi = macdAll.length ? clamp(bisectByT(macdAll, t1), 0, macdAll.length - 1) : -1;
    const macd = macdAll.length ? macdAll.slice(Math.max(0, macdLo - buf), Math.min(macdAll.length, macdHi + buf + 1)) : [];

    const volLo = volAll.length ? clamp(bisectByT(volAll, t0), 0, volAll.length - 1) : 0;
    const volHi = volAll.length ? clamp(bisectByT(volAll, t1), 0, volAll.length - 1) : -1;
    const volume = volAll.length ? volAll.slice(Math.max(0, volLo - buf), Math.min(volAll.length, volHi + buf + 1)) : [];

    // Cursor: snap to nearest visible bar
    let cursorBar = null;
    if (this.state.cursorT != null && bars.length) {
      const idx = clamp(bisectByT(bars, this.state.cursorT), 0, bars.length - 1);
      cursorBar = bars[idx];
    }

    return {
      W, H,
      rightAxisW: 62,
      panes,
      xDomain: this.state.xDomain,
      bars,
      macd,
      volume,
      // Indicator arrays — sliced to match visible bars
      rsi:  this.state.indicators?.rsi  ? (this.state.rsi  ?? []).slice(i0, i1 + 1) : null,
      bb:   this.state.indicators?.bb   ? (() => {
        const b = this.state.bb;
        if (!b) return null;
        return { upper: b.upper.slice(i0, i1+1), mid: b.mid.slice(i0, i1+1), lower: b.lower.slice(i0, i1+1) };
      })() : null,
      vwap: this.state.indicators?.vwap ? (this.state.vwap ?? []).slice(i0, i1 + 1) : null,
      // Drawings
      drawings:  this.state.drawings  ?? [],
      // Markers etc.
      markers:   this.state.markers,
      events:    this.state.events,
      positions: this.state.positions,
      cursorBar,
      state: this.state,
    };
  }
}
