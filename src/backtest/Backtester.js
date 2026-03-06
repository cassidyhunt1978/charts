/**
 * Backtester.js
 * Chronological walk-forward simulation — no lookahead.
 *
 * testFn(ctx) is the same context-object predicate produced by
 * StrategyAnalyzer / computeBarContext.
 */

import { computeBarContext } from "../signals/StrategyAnalyzer.js";

/**
 * @param {object[]}  bars       full bar array (state.bars)
 * @param {object}    state      full engine state (for context computation)
 * @param {function}  testFn     (ctx) => boolean — entry condition
 * @param {number}    holdMs     target hold duration in ms
 * @param {object}    [opts]
 * @param {number}    [opts.feeBps=8]     round-trip fee in basis points
 * @param {number}    [opts.startCash=10000]
 * @returns {BacktestResult}
 */
export function runBacktest(bars, state, testFn, holdMs, opts = {}) {
  const { feeBps = 8, startCash = 10_000 } = opts;
  const feeRate  = feeBps / 10_000;
  const minGapMs = holdMs * 0.5;

  const trades  = [];
  const equity  = [{ t: bars[0]?.t ?? 0, v: startCash }];
  let cash      = startCash;
  let position  = null;
  let lastEntryT = -Infinity;

  for (let i = 20; i < bars.length; i++) {
    const bar = bars[i];

    // ── Close open position when hold time expires ────────────
    if (position && bar.t >= position.entryT + holdMs) {
      const pct    = (bar.c - position.entryPrice) / position.entryPrice;
      const netPct = pct - feeRate;          // subtract exit fee
      cash *= (1 + netPct);
      trades.push({
        entryT:     position.entryT,
        exitT:      bar.t,
        entryPrice: position.entryPrice,
        exitPrice:  bar.c,
        pnl:        bar.c - position.entryPrice,
        pct:        netPct * 100,
        win:        netPct > 0,
      });
      equity.push({ t: bar.t, v: cash });
      position   = null;
      lastEntryT = bar.t;
    }

    // ── Open new position when condition fires ────────────────
    if (!position && bar.t - lastEntryT >= minGapMs) {
      const ctx = computeBarContext(bars, i, state);
      if (testFn(ctx)) {
        cash      *= (1 - feeRate);          // entry fee
        position   = { entryT: bar.t, entryPrice: bar.c };
        equity.push({ t: bar.t, v: cash });
      }
    }
  }

  // Close any open trade at the last bar
  if (position && bars.length > 0) {
    const bar    = bars[bars.length - 1];
    const pct    = (bar.c - position.entryPrice) / position.entryPrice;
    const netPct = pct - feeRate / 2;
    cash *= (1 + netPct);
    equity.push({ t: bar.t, v: cash });
  }

  const wins     = trades.filter(t => t.win);
  const losses   = trades.filter(t => !t.win);
  const grossWin = wins.reduce((s, t) => s + t.pnl,   0);
  const grossLos = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    trades,
    equity,
    tradeCount:   trades.length,
    winCount:     wins.length,
    lossCount:    losses.length,
    winRate:      trades.length ? (wins.length / trades.length) * 100 : 0,
    totalReturn:  ((cash - startCash) / startCash) * 100,
    finalEquity:  cash,
    maxDrawdown:  _maxDrawdown(equity),
    sharpe:       _sharpe(trades),
    profitFactor: grossLos > 0 ? grossWin / grossLos : grossWin > 0 ? Infinity : 0,
  };
}

function _maxDrawdown(equity) {
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) {
    if (e.v > peak) peak = e.v;
    const dd = peak > 0 ? (peak - e.v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

function _sharpe(trades) {
  if (trades.length < 2) return 0;
  const rets = trades.map(t => t.pct);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const std  = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length);
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}
