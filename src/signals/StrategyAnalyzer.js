/**
 * StrategyAnalyzer
 *
 * Given a list of completed trades (each with context.macd_hist and
 * context.ema_spread recorded at entry), this module evaluates which
 * indicator conditions correlate with winning trades and synthesises a
 * human-readable "formula" recommendation.
 *
 * Conditions tested:
 *   A. MACD histogram > 0 at entry (bullish momentum)
 *   B. EMA9 > EMA21 at entry       (price above fast MA, uptrend)
 *   C. Both A + B                  (full confluence)
 *   D. Neither A nor B             (counter-trend)
 *
 * Also analyses hold-time correlation:
 *   - Do shorter holds produce better win rates?
 */

/**
 * Compute the same context object that PnLLayer attaches to each trade's
 * entryContext.  Safe to call with any bar index into state.bars.
 *
 * @param {object[]} bars    state.bars
 * @param {number}   i       index into bars
 * @param {object}   state   full engine state
 * @returns {object}         context fields (may contain nulls)
 */
export function computeBarContext(bars, i, state) {
  const bar      = bars[i];
  const lookback = 20;
  const wStart   = Math.max(0, i - lookback + 1);
  const winBars  = bars.slice(wStart, i + 1);
  const volume   = state.volume ?? [];
  const winVols  = volume.slice(wStart, i + 1);

  const sma20   = winBars.length ? winBars.reduce((s, b) => s + b.c, 0) / winBars.length : null;
  const r20High = winBars.length ? Math.max(...winBars.map(b => b.h)) : null;
  const r20Low  = winBars.length ? Math.min(...winBars.map(b => b.l)) : null;
  const r20     = (r20High != null && r20Low != null && r20High > r20Low) ? r20High - r20Low : null;
  const avgVol  = winVols.length  ? winVols.reduce((s, v) => s + (v.v ?? 0), 0) / winVols.length : null;
  const thisVol = volume[i]?.v ?? null;

  return {
    macd_hist:      (state.macd  ?? [])[i]?.hist                                      ?? null,
    ema_spread:     ((state.ema9 ?? [])[i] != null && (state.ema21 ?? [])[i] != null)
                      ? (state.ema9[i] - state.ema21[i])
                      : null,
    candle_bull:    bar.c > bar.o,
    above_sma20:    sma20  != null ? bar.c > sma20 : null,
    price_vs_range: r20    != null ? (bar.c - r20Low) / r20 : null,
    vol_ratio:      (avgVol && avgVol > 0 && thisVol != null) ? thisVol / avgVol : null,
  };
}

/**
 * @param {object[]} trades
 * @param {string}   label
 * @param {function} testFn  (ctx: object) => boolean  — tests a context object
 */
function bucket(trades, label, testFn) {
  const sub    = trades.filter(t => t.entryContext ? testFn(t.entryContext) : testFn({}));
  const wins   = sub.filter(t => t.win);
  const avgPnl = sub.length ? sub.reduce((s, t) => s + t.pnl, 0) / sub.length : 0;
  const avgPct = sub.length ? sub.reduce((s, t) => s + t.pct, 0) / sub.length : 0;
  const avgHoldMs = sub.length ? sub.reduce((s, t) => s + (t.holdMs ?? 0), 0) / sub.length : 0;
  return {
    label,
    testFn,           // ← exposed so Engine can apply it to raw bars
    n:       sub.length,
    wins:    wins.length,
    losses:  sub.length - wins.length,
    winRate: sub.length ? (wins.length / sub.length) * 100 : 0,
    avgPnl,
    avgPct,
    avgHoldMs,
  };
}

function fmtHold(ms) {
  if (!ms || ms <= 0) return "—";
  const mins = Math.round(ms / 60_000);
  if (mins < 60)  return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins/60)}h ${mins%60}m`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function fmtPnl(v) {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)} (${sign}${v.toFixed ? ((v < 0 ? "" : "+") + v) : ""}`;
}

export function analyzeStrategy(tradeList) {
  if (!tradeList || tradeList.length < 2) {
    return { html: `<p class="sp-formula-empty">Need at least 2 completed trades to find patterns.</p>` };
  }

  // Filter trades that have context data attached
  const withCtx = tradeList.filter(t =>
    t.entryContext &&
    t.entryContext.macd_hist != null &&
    t.entryContext.ema_spread != null
  );

  const hasCtx = withCtx.length >= 2;
  const base = hasCtx ? withCtx : tradeList;

  const all = bucket(base, "All trades", () => true);

  // Indicator condition buckets — testFn operates on a context object (not a trade)
  const condBuckets = hasCtx ? [
    // ── MACD ────────────────────────────────────────────────────
    bucket(base, "MACD hist > 0 (bullish momentum)",    c => c.macd_hist  >  0),
    bucket(base, "MACD hist ≤ 0 (bearish momentum)",    c => c.macd_hist != null && c.macd_hist <= 0),
    // ── EMA trend ───────────────────────────────────────────────
    bucket(base, "EMA9 > EMA21 (uptrend)",              c => c.ema_spread  >  0),
    bucket(base, "EMA9 < EMA21 (downtrend)",            c => c.ema_spread != null && c.ema_spread < 0),
    // ── Entry candle colour ─────────────────────────────────────
    bucket(base, "Bullish entry candle (close > open)", c => c.candle_bull === true),
    bucket(base, "Bearish entry candle (close < open)", c => c.candle_bull === false),
    // ── Price vs 20-bar SMA ─────────────────────────────────────
    bucket(base, "Entry above 20-bar SMA",              c => c.above_sma20 === true),
    bucket(base, "Entry below 20-bar SMA",              c => c.above_sma20 === false),
    // ── Price position in 20-bar range ─────────────────────────
    bucket(base, "Entry near range bottom (≤40%)",      c => c.price_vs_range != null && c.price_vs_range <= 0.4),
    bucket(base, "Entry near range top (≥60%)",         c => c.price_vs_range != null && c.price_vs_range >= 0.6),
    // ── Volume ──────────────────────────────────────────────────
    bucket(base, "Volume surge at entry (>1.5× avg)",  c => c.vol_ratio != null && c.vol_ratio > 1.5),
    bucket(base, "Low volume at entry (<0.8× avg)",     c => c.vol_ratio != null && c.vol_ratio < 0.8),
    // ── Confluence ──────────────────────────────────────────────
    bucket(base, "Confluence: MACD↑ + green candle",   c => c.macd_hist > 0 && c.candle_bull === true),
    bucket(base, "Confluence: below SMA + low range",  c => c.above_sma20 === false && c.price_vs_range != null && c.price_vs_range <= 0.4),
  ].filter(b => b.n > 0) : [];

  // Hold-time tercile buckets (split into short/medium/long thirds)
  const sorted = [...base].sort((a, b) => (a.holdMs ?? 0) - (b.holdMs ?? 0));
  const third  = Math.max(1, Math.floor(sorted.length / 3));
  const holdBuckets = base.length >= 3 ? [
    bucket(sorted.slice(0, third),        `Short holds (≤${fmtHold(sorted[third-1]?.holdMs ?? 0)})`,   () => true),
    bucket(sorted.slice(third, third*2),  `Medium holds`,                                               () => true),
    bucket(sorted.slice(third*2),         `Long holds (≥${fmtHold(sorted[third*2]?.holdMs ?? 0)})`,    () => true),
  ] : [];

  // Find best condition rule
  const candidates = condBuckets.filter(b => b.n >= 2);
  const bestCond = candidates.reduce(
    (best, b) => (!best || b.winRate > best.winRate || (b.winRate === best.winRate && b.n > best.n)) ? b : best,
    null
  );

  const bestHold = holdBuckets.reduce(
    (best, b) => (!best || b.winRate > best.winRate) ? b : best,
    null
  );

  // ── Build HTML output ──────────────────────────────────────
  const sign = v => v >= 0 ? "+" : "";

  const rowHtml = (b, highlight) => `
    <tr class="${highlight ? 'sf-best-row' : ''}">
      <td class="sf-label">${b.label}${highlight ? ' ⭐' : ''}</td>
      <td>${b.n}</td>
      <td class="${b.winRate >= 50 ? 'bull' : 'bear'}">${b.winRate.toFixed(0)}%</td>
      <td class="${b.avgPnl >= 0 ? 'bull' : 'bear'}">${sign(b.avgPnl)}${b.avgPnl.toFixed(2)}</td>
      <td>${fmtHold(b.avgHoldMs)}</td>
    </tr>`;

  let formulaBox = "";
  if (bestCond) {
    const edge = bestCond.winRate - all.winRate;
    const edgeStr = edge >= 0
      ? `<span class="bull">+${edge.toFixed(0)}% above baseline</span>`
      : `<span class="bear">${edge.toFixed(0)}% vs baseline</span>`;
    formulaBox = `
      <div class="sf-formula-box">
        <div class="sf-formula-title">Suggested entry filter</div>
        <div class="sf-formula-rule">${bestCond.label}</div>
        <div class="sf-formula-meta">
          Win rate ${bestCond.winRate.toFixed(1)}% on ${bestCond.n} trades &mdash; ${edgeStr}
          &nbsp;|&nbsp; Avg hold ${fmtHold(bestCond.avgHoldMs)}
        </div>
        ${bestHold && bestHold.winRate > all.winRate + 5 ? `
        <div class="sf-formula-meta" style="margin-top:4px">
          ⏱ Best hold duration: <strong>${bestHold.label}</strong>
          &mdash; ${bestHold.winRate.toFixed(0)}% win rate
        </div>` : ""}
        <button class="btn btn-accent sf-plot-btn" id="sf-plot-btn"
          style="margin-top:8px;font-size:11px;padding:3px 12px"
          title="Place Buy/Sell signals on every bar matching this formula">
          📍 Plot on Chart
        </button>
      </div>`;
  }

  const condTable = condBuckets.length ? `
    <div class="sf-section-title">Entry conditions</div>
    <table class="sf-table">
      <thead><tr><th>Condition</th><th>Trades</th><th>Win%</th><th>Avg P&L</th><th>Avg Hold</th></tr></thead>
      <tbody>
        ${rowHtml(all, false)}
        ${condBuckets.map(b => rowHtml(b, b === bestCond)).join("")}
      </tbody>
    </table>` : `<p class="sp-formula-empty" style="margin:8px 0">
      Indicator context unavailable for these trades.
      Try adding signals after loading data so MACD/EMA values are captured.
    </p>`;

  const holdTable = holdBuckets.length ? `
    <div class="sf-section-title" style="margin-top:10px">Hold duration analysis</div>
    <table class="sf-table">
      <thead><tr><th>Duration</th><th>Trades</th><th>Win%</th><th>Avg P&L</th><th>Avg Hold</th></tr></thead>
      <tbody>${holdBuckets.map(b => rowHtml(b, b === bestHold)).join("")}</tbody>
    </table>` : "";

  const noCtxNote = !hasCtx && base.length > 0 ? `
    <p class="sp-formula-empty" style="margin-bottom:6px;color:#f59e0b">
      ⚠ No indicator context found on trades. Auto-signals populate this;
      user-placed markers will be enriched on next data reload.
    </p>` : "";

  return {
    html: `
      <div class="sf-wrap">
        ${noCtxNote}
        ${formulaBox}
        ${condTable}
        ${holdTable}
      </div>`,
    bestCond,
    bestHold,
  };
}

export { fmtHold };
