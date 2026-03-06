/**
 * ReportGenerator.js — Comprehensive multi-TF optimization + backtest report.
 *
 * Tests every strategy against all 6 report timeframes (1m → 1d).
 * TFs below the base data resolution are skipped automatically.
 * Volume is correctly aggregated during resampling (via Aggregator).
 *
 * Usage:
 *   const report = await ReportGenerator.generateFullReport(bars, strategy, opts);
 *   // → { summary, detailed, html }
 */

import { optimizeStrategyAsync }      from "../signals/SignalOptimizer.js";
import { runSignalScan }              from "../signals/SignalEngine.js";
import { getPivotStrategies }         from "../optimizer/PivotStrategies.js";
import { resample, tfToMinutes } from "./Aggregator.js";

// ── report TF set (always tested in this order) ──────────────────────────────
const REPORT_TFS = [
  { tf: "1m",  min: 1    },
  { tf: "5m",  min: 5    },
  { tf: "15m", min: 15   },
  { tf: "1h",  min: 60   },
  { tf: "4h",  min: 240  },
  { tf: "1d",  min: 1440 },
];

// ── helpers ───────────────────────────────────────────────────────────────────
const _fmt2 = n => (typeof n === "number" && isFinite(n)) ? n.toFixed(2) : "–";
const _fmt0 = n => (typeof n === "number" && isFinite(n)) ? Math.round(n).toLocaleString() : "–";

/**
 * Minimum confirmed trades required before we trust a TF result.
 * Higher TFs consolidate more bars so need fewer sample trades.
 */
function _minTrades(tfMin) {
  if (tfMin >= 1440) return 3;
  if (tfMin >= 240)  return 4;
  if (tfMin >= 60)   return 5;
  return 8;
}

/**
 * Clone a strategy loosening regime/vol-gate conditions for higher TFs.
 * `regime_tradeable` and `forecast_clears_fees` are noise-reduction gates
 * designed for 1m/5m data; on consolidated 1h/4h/1d bars they over-filter
 * and produce zero trades.
 */
function _loosenHigherTFStrategy(strategy, tfMin) {
  if (tfMin < 60) return strategy;  // only loosen for ≥ 1h
  const s = JSON.parse(JSON.stringify(strategy));
  s.entry.conditions = (s.entry.conditions ?? []).map(c => {
    if (c.id === 'regime_tradeable') {
      // Lower ADX threshold → more regimes pass on larger consolidated bars
      const thr = tfMin >= 1440 ? 12 : 16;
      return { ...c, params: { ...c.params, adx_threshold: Math.min(c.params?.adx_threshold ?? 22, thr) } };
    }
    if (c.id === 'forecast_clears_fees') {
      // Reduce safety margin → fee gate is less restrictive on bigger bars
      const mg = tfMin >= 1440 ? 1.0 : 1.3;
      return { ...c, params: { ...c.params, margin: Math.min(c.params?.margin ?? 2.0, mg) } };
    }
    return c;
  });
  return s;
}

/**
 * Run one strategy against one bar array. Returns compact stats, or null when
 * bar count or trade count is insufficient.
 *
 * IMPORTANT: runSignalScan() returns { signals, trades, stats } — an object,
 * NOT an array. This function destructures correctly and reuses the
 * pre-computed stats rather than calling computeTradeStats a second time.
 */
async function _quickBacktest(bars, strategy, tfLabel, tfMin) {
  const minBars = Math.max(20, Math.ceil(200 / Math.max(tfMin, 1)));
  if (!bars || bars.length < minBars) {
    console.debug(`[Report] ${tfLabel} skip: ${bars?.length ?? 0}/${minBars} bars`);
    return null;
  }
  // Loosen regime/volatility gates for higher TFs
  const strat = _loosenHigherTFStrategy(strategy, tfMin);
  // runSignalScan returns { signals, trades, stats } — destructure properly
  const { stats } = runSignalScan(bars, strat);
  if (!stats || stats.total < _minTrades(tfMin)) {
    console.debug(
      `[Report] ${tfLabel} ${strategy.name?.slice(0, 20) ?? '?'}: ` +
      `${stats?.total ?? 0}t (need ${_minTrades(tfMin)}) bars=${bars.length}`
    );
    return null;
  }
  console.debug(
    `[Report] ${tfLabel} ${strategy.name?.slice(0, 20) ?? '?'}: ` +
    `PF=${stats.profit_factor} WR=${stats.win_rate}% t=${stats.total}`
  );
  return {
    tf:            tfLabel,
    tfMin,
    strategy_name: strategy.meta?.name ?? strategy.name ?? 'Unnamed',
    pf:            stats.profit_factor ?? 0,
    win_rate:      stats.win_rate ?? 0,
    net_pnl_usd:   stats.net_pnl_usd ?? 0,
    trade_count:   stats.total,
    avg_rr:        stats.avg_rr ?? 0,
    is_pivot:      false,
  };
}

// ── main export ───────────────────────────────────────────────────────────────
export class ReportGenerator {
  /**
   * buildCuratedTable(bars, optResult, opts)
   *
   * Rapid multi-TF cross-backtest of the top N strategies from an optimizer run.
   * Produces the same shape as the `detailed` array in generateFullReport but
   * skips the full optimizer re-run and pivot sweep — runs in < 1 s.
   *
   * Each returned entry is suitable for direct rendering in the panel table:
   *   { tf, tfMin, strategy_name, strategy, dir, conditions,
   *     pf, win_rate, trade_count, avg_rr, net_pnl_usd, is_pivot, rank }
   *
   * @param {Bar[]}  bars       1m (or baseTF) bars for the current symbol
   * @param {object} optResult  { topResults, passStats } from optimizeStrategyAsync
   * @param {object} [opts]
   * @param {number} [opts.topN=3]      How many topResults strategies to cross-test
   * @param {string} [opts.baseTF='1m'] Resolution of the input bars
   * @returns {Promise<object[]>}  Sorted by PF desc, max 15 entries
   */
  static async buildCuratedTable(bars, optResult, opts = {}) {
    const { topN = 10, baseTF = '1m' } = opts;
    const topResults = optResult?.topResults ?? [];
    if (!bars?.length || !topResults.length) return [];

    const baseTFMin = tfToMinutes(baseTF);
    // Exclude the base TF itself from curated backtests.
    // When baseTF=1m, testing the top 1m strategy ON 1m bars just reproduces
    // the raw optimizer output (3000+ trades, 4.5% WR) — the exact noise we want
    // to hide.  Real curated value comes from RESAMPLED higher-TF bars.
    const curatedMinTF = Math.max(5, baseTFMin);
    const targets   = REPORT_TFS.filter(x => x.min >= curatedMinTF);

    // Pre-build resampled bar cache. Keep baseTFMin entry so pivot strategies
    // that specifically request it can still use it, but targets won't include it.
    const barsCache = new Map([[baseTFMin, bars]]);
    for (const { min } of targets) {
      if (!barsCache.has(min)) barsCache.set(min, resample(bars, min));
    }

    const curated = [];

    for (let ri = 0; ri < Math.min(topN, topResults.length); ri++) {
      const r     = topResults[ri];
      const strat = r.strategy;
      if (!strat) continue;

      const condLabels = (strat.entry?.conditions ?? [])
        .filter(c => c.enabled !== false)
        .map(c => c.id);

      for (const { tf, min: tfMin } of targets) {
        await new Promise(res => setTimeout(res, 0));          // yield to UI
        const tfBars = barsCache.get(tfMin);
        const res    = await _quickBacktest(tfBars, strat, tf, tfMin);
        if (!res) continue;
        curated.push({
          ...res,
          strategy:   strat,
          dir:        strat.entry?.direction ?? '?',
          conditions: condLabels,
          is_pivot:   r.is_pivot ?? false,
          rank:       ri,
        });
      }
    }

    // ── Also test all built-in pivot strategies ─────────────────────────────
    // Pivot strategies evaluate poorly on raw 1m bars (the optimizer's native
    // evaluation surface), so the profitable ones may never appear in
    // topResults[0..topN-1].  We always test them here unconditionally so that
    // a result like "1h Pivot R1 · PF 1.48" surfaces in the panel table.
    const pivots = getPivotStrategies();
    for (const pStrat of pivots) {
      for (const { tf, min: tfMin } of targets) {
        await new Promise(res => setTimeout(res, 0));        // yield to UI
        const pRes = await _quickBacktest(barsCache.get(tfMin), pStrat, tf, tfMin);
        if (!pRes) continue;
        curated.push({
          ...pRes,
          strategy:   pStrat,
          dir:        pStrat.entry?.direction ?? '?',
          conditions: (pStrat.entry?.conditions ?? [])
            .filter(c => c.enabled !== false).map(c => c.id),
          is_pivot:   true,
          rank:       99,   // ranked behind optimizer results in tie-breaks
        });
      }
    }

    // Dedup by strategy_name|tf — keep highest PF
    const dedupMap = new Map();
    for (const d of curated) {
      const k = d.strategy_name + '|' + d.tf;
      if (!dedupMap.has(k) || d.pf > dedupMap.get(k).pf) dedupMap.set(k, d);
    }

    const sorted = [...dedupMap.values()]
      // Quality gate: require a minimum trade count so stats are meaningful.
      // PF threshold is kept very low (0.05) — getCuratedResults() in the panel
      // applies the user-facing pf > 0.05 filter; we store more here so the
      // panel display pool is rich enough to fill 5–15 rows.
      .filter(d => d.trade_count >= 3 && d.pf > 0.05)
      .sort((a, b) => b.pf - a.pf)
      .slice(0, 25);   // store up to 25; panel trims to 15 on display

    console.log(
      `[ReportGenerator.buildCuratedTable] ${sorted.length} curated entries` +
      ` (TFs tested: ${targets.map(t => t.tf).join(', ')}, base excluded: ${baseTF})`,
      sorted
    );
    return sorted;
  }


  /**
   * generateFullReport(bars, strategy, opts)
   *
   * @param {Bar[]}    bars           Full bar array at baseTF resolution.
   * @param {object}   strategy       Starting strategy to optimise from.
   * @param {object}   [opts]
   * @param {string}   [opts.symbol]        Display symbol (e.g. "BTC/USD")
   * @param {string}   [opts.baseTF]        Resolution of input bars  (e.g. "1m")
   * @param {number}   [opts.topN]          Optimiser results to backtest (default 3)
   * @param {Function} [opts.progressCb]    Called with { phase, label, pct }
   * @param {AbortSignal} [opts.signal]     Abort token
   *
   * @returns {Promise<{summary, detailed, html}>}
   */
  static async generateFullReport(bars, strategy, opts = {}) {
    const {
      symbol     = "–",
      baseTF     = "1m",
      topN       = 3,
      progressCb = null,
      signal     = null,
      allTfs     = null,
      // Pass a pre-computed optimizer result to skip the expensive re-run.
      optResult: precomputedResult = null,
    } = opts;

    const aborted  = () => signal?.aborted === true;
    const emit     = (phase, label, pct = -1) => progressCb?.({ phase, label, pct });
    const detailed = [];

    const baseTFMin = tfToMinutes(baseTF);

    const tfBars = {};
    const allowedTFs = allTfs ? new Set(allTfs) : null;
    for (const { tf, min } of REPORT_TFS) {
      if (min < baseTFMin) continue;
      if (allowedTFs && !allowedTFs.has(tf)) continue;
      tfBars[tf] = (min === baseTFMin) ? bars : resample(bars, min);
    }
    const activeTFs = Object.keys(tfBars);

    // ── 1. Use pre-computed result or run optimizer ──────────────────────────
    let optResult = precomputedResult ?? null;
    if (!optResult && !aborted()) {
      emit("opt", "Running full optimizer…");
      optResult = await optimizeStrategyAsync(bars, strategy, {
        topN:       Math.max(topN, 5),
        autoPivot:  true,
        multiTF:    true,
        baseTF,
        signal,
        progressCb: ({ phase, tested, total }) => {
          const pct = total && total !== "?" ? Math.round((tested / +total) * 100) : -1;
          emit(`opt-p${phase}`, `Opt P${phase} · ${tested}${total !== "?" ? `/${total}` : ""}`, pct);
        },
      });
    } else if (optResult) {
      emit("opt", "Using existing optimizer result — skipping re-run", 100);
    }

    // ── 2. Backtest each top strategy across all report TFs ───────────────
    const topStrategies = optResult?.topResults?.slice(0, topN) ?? [];
    const total2 = topStrategies.length * activeTFs.length;
    let   done2  = 0;

    for (const r of topStrategies) {
      if (aborted()) break;
      const strat = r.strategy;
      for (const tf of activeTFs) {
        if (aborted()) break;
        const entry = REPORT_TFS.find(x => x.tf === tf);
        const res   = await _quickBacktest(tfBars[tf], strat, tf, entry.min);
        if (res) detailed.push(res);
        const pct = Math.round((++done2 / total2) * 100);
        emit("backtest", `Backtesting ${strat.name?.slice(0, 22) ?? "strategy"} @ ${tf}`, pct);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ── 3. Backtest all 8 pivot strategies across all report TFs ──────────
    const pivots = getPivotStrategies();
    const total3 = pivots.length * activeTFs.length;
    let   done3  = 0;

    for (const pStrat of pivots) {
      if (aborted()) break;
      for (const tf of activeTFs) {
        if (aborted()) break;
        const entry = REPORT_TFS.find(x => x.tf === tf);
        const res   = await _quickBacktest(tfBars[tf], pStrat, tf, entry.min);
        if (res) { res.is_pivot = true; detailed.push(res); }
        const pct = Math.round((++done3 / total3) * 100);
        emit("pivots", `Pivot: ${pStrat.name?.slice(0, 22)} @ ${tf}`, pct);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ── 4. Deduplicate (keep best PF per strategy × TF pair) ─────────────
    // Duplicate entries arise when the same strategy appears in both the
    // optimiser topResults and the pivot fallback list.
    const _dedupMap = new Map();
    for (const d of detailed) {
      const k = d.strategy_name + '|' + d.tf;
      if (!_dedupMap.has(k) || d.pf > _dedupMap.get(k).pf) _dedupMap.set(k, d);
    }
    detailed.splice(0, Infinity, ..._dedupMap.values());

    // ── 5. Aggregate summary ──────────────────────────────────────────────
    const profitable = detailed.filter(d => d.pf > 1.0);
    const pfVals     = detailed.map(d => d.pf).filter(isFinite);
    const overallPF  = pfVals.length ? pfVals.reduce((a, b) => a + b, 0) / pfVals.length : 0;

    const best = detailed.slice().sort((a, b) => b.pf - a.pf)[0];

    const tfScore = {};
    for (const d of profitable) tfScore[d.tf] = (tfScore[d.tf] ?? 0) + 1;
    const bestTF = Object.entries(tfScore).sort((a, b) => b[1] - a[1])[0]?.[0] ?? baseTF;

    let feeDragPct = 0;
    const feeRt = 0.0065;
    if (best) {
      const gross_est = best.avg_rr * (best.win_rate / 100) - (1 - best.win_rate / 100);
      feeDragPct = gross_est > 0.001
        ? Math.min(99, (feeRt * 2 / Math.abs(gross_est)) * 100)
        : 0;
    }

    const summary = {
      generated_at:            new Date().toISOString(),
      symbol,
      base_tf:                 baseTF,
      active_tfs:              activeTFs,
      overall_avg_pf:          +overallPF.toFixed(3),
      profitable_count:        profitable.length,
      total_entries:           detailed.length,
      best_strategy_name:      best?.strategy_name ?? "–",
      best_tf:                 best?.tf ?? baseTF,
      best_pf:                 +(best?.pf ?? 0).toFixed(3),
      recommended_tf:          bestTF,
      fee_drag_est_pct:        +feeDragPct.toFixed(1),
      total_strategies_tested: new Set(detailed.map(d => d.strategy_name + "|" + d.tf)).size,
      opt_combos:              optResult?.passStats?.totalCombos ?? 0,
      opt_elapsed_ms:          optResult?.passStats?.elapsedMs   ?? 0,
      pivots_tested_in_opt:    optResult?.passStats?.pivotsTested ?? 0,
      promoted_to_higher_tf:   optResult?.passStats?.promotedToHigherTF ?? false,
    };

    const html = ReportGenerator._buildHTML(summary, detailed, activeTFs);
    return { summary, detailed, html };
  }

  // ── HTML — strategy × TF grid ─────────────────────────────────────────────

  static _buildHTML(summary, detailed, activeTFs) {
    // Index: strategyName + "|" + tf → result
    const idx = new Map();
    for (const d of detailed) idx.set(d.strategy_name + "|" + d.tf, d);

    // Unique strategies in order seen (optimised first, then pivots)
    const stratOrder = [];
    const seen = new Set();
    for (const d of detailed) {
      if (!seen.has(d.strategy_name)) {
        seen.add(d.strategy_name);
        stratOrder.push({ name: d.strategy_name, is_pivot: d.is_pivot });
      }
    }

    const tfHeaders = activeTFs.map(tf =>
      `<th>${tf}</th>`
    ).join("");

    // Helper: render one strategy row
    const renderRow = ({ name, is_pivot }) => {
      const label   = name.replace(/^Pivot:\s*/i, "");
      const pivIcon = is_pivot ? " 📌" : "";
      const cells   = activeTFs.map(tf => {
        const d = idx.get(name + "|" + tf);
        if (!d) return `<td class="rg-no-data">–</td>`;
        const pfCls = d.pf >= 1.5 ? "rg-pf-hi" : d.pf >= 1.0 ? "rg-pf-ok" : "rg-pf-lo";
        const tip   = `WR ${d.win_rate}% · ${d.trade_count}t · R:R ${d.avg_rr.toFixed(1)}`;
        return `<td class="${pfCls}" title="${tip}">${_fmt2(d.pf)}</td>`;
      }).join("");
      const rowCls = is_pivot ? ` class="rg-pivot-row"` : "";
      return `<tr${rowCls}><td class="rg-strat-name">${label}${pivIcon}</td>${cells}</tr>`;
    };

    // Best PF per TF footer row
    const bestPerTF = activeTFs.map(tf => {
      const b = detailed.filter(d => d.tf === tf).sort((a, b) => b.pf - a.pf)[0];
      if (!b) return `<td class="rg-no-data">–</td>`;
      const pfCls = b.pf >= 1.5 ? "rg-pf-hi" : b.pf >= 1.0 ? "rg-pf-ok" : "rg-pf-lo";
      return `<td class="${pfCls}" title="${b.strategy_name}">${_fmt2(b.pf)}</td>`;
    }).join("");

    // Count profitable per TF
    const profPerTF = activeTFs.map(tf => {
      const n   = detailed.filter(d => d.tf === tf && d.pf > 1.0).length;
      const tot = detailed.filter(d => d.tf === tf).length;
      return `<td style="color:#6677aa">${n}/${tot}</td>`;
    }).join("");

    const optimisedRows = stratOrder.filter(s => !s.is_pivot).map(renderRow).join("\n");
    const pivotRows     = stratOrder.filter(s =>  s.is_pivot).map(renderRow).join("\n");

    const promoNote = summary.promoted_to_higher_tf
      ? `<div class="rg-banner rg-banner-orange">📈 Base TF unprofitable — higher TF may perform better. Check Rec. TF.</div>` : "";

    const colCount = activeTFs.length + 1;

    return `
<style>
  .rg-report        { font:11.5px/1.45 ui-monospace,monospace; color:#dee4f0; background:#0d1020; padding:14px 16px; border-radius:8px; overflow-x:auto; }
  .rg-title         { font-size:13px; font-weight:700; margin-bottom:10px; color:#b8d0ff; }
  .rg-kpis          { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .rg-kpi           { background:#161926; padding:5px 10px; border-radius:4px; min-width:72px; }
  .rg-kpi span      { color:#44558a; font-size:10px; display:block; }
  .rg-tbl           { border-collapse:collapse; width:100%; }
  .rg-tbl th        { background:#161926; padding:5px 9px; text-align:center; color:#7788bb; font-size:10px; font-weight:700; border-bottom:1px solid #1e2338; white-space:nowrap; }
  .rg-tbl th:first-child { text-align:left; width:220px; }
  .rg-tbl td        { padding:4px 9px; border-bottom:1px solid #131625; text-align:center; font-size:11px; white-space:nowrap; }
  .rg-tbl td:first-child { text-align:left; }
  .rg-tbl tr:hover td { background:#181c30; }
  .rg-pivot-row td  { background:#110e22; }
  .rg-pivot-row:hover td { background:#1c1830; }
  .rg-strat-name    { color:#b8c8f0; max-width:220px; overflow:hidden; text-overflow:ellipsis; font-size:11px; }
  .rg-pf-hi         { color:#4ade80; font-weight:700; }
  .rg-pf-ok         { color:#86e07f; }
  .rg-pf-lo         { color:#f87171; }
  .rg-no-data       { color:#2a3050; }
  .rg-separator td  { background:#161926; font-size:9px; color:#44558a; font-style:italic; padding:3px 9px; }
  .rg-best-row td   { background:#0d1828; font-weight:700; font-size:11px; border-top:1px solid #1e2338; }
  .rg-banner        { padding:6px 10px; border-radius:4px; margin-bottom:10px; font-size:11px; }
  .rg-banner-orange { background:#281400; border:1px solid #8a4000; color:#ffb74d; }
</style>
<div class="rg-report">
  <div class="rg-title">📊 Full Report — ${summary.symbol} · base ${summary.base_tf} · ${new Date(summary.generated_at).toLocaleString()}</div>
  ${promoNote}
  <div class="rg-kpis">
    <div class="rg-kpi"><span>Best PF</span>${_fmt2(summary.best_pf)}</div>
    <div class="rg-kpi"><span>Best TF</span>${summary.best_tf}</div>
    <div class="rg-kpi"><span>Rec. TF</span>${summary.recommended_tf}</div>
    <div class="rg-kpi"><span>Best Strategy</span>${(summary.best_strategy_name ?? "–").replace(/^Pivot:\s*/i,"").slice(0,28)}</div>
    <div class="rg-kpi"><span>Profitable</span>${summary.profitable_count}/${summary.total_entries}</div>
    <div class="rg-kpi"><span>Avg PF</span>${_fmt2(summary.overall_avg_pf)}</div>
    <div class="rg-kpi"><span>Fee drag</span>${summary.fee_drag_est_pct}%</div>
    <div class="rg-kpi"><span>Opt combos</span>${_fmt0(summary.opt_combos)}</div>
  </div>
  <table class="rg-tbl">
    <thead>
      <tr><th>Strategy</th>${tfHeaders}</tr>
    </thead>
    <tbody>
      <tr class="rg-separator"><td colspan="${colCount}">▸ Optimised strategies</td></tr>
      ${optimisedRows || `<tr><td colspan="${colCount}" class="rg-no-data" style="padding:6px 9px">No optimised results (run optimizer first)</td></tr>`}
      <tr class="rg-separator"><td colspan="${colCount}">📌 Pivot strategies</td></tr>
      ${pivotRows || `<tr><td colspan="${colCount}" class="rg-no-data" style="padding:6px 9px">–</td></tr>`}
      <tr class="rg-separator"><td colspan="${colCount}"></td></tr>
      <tr class="rg-best-row"><td>🏆 Best PF per TF</td>${bestPerTF}</tr>
      <tr><td style="color:#44558a;font-size:10px">Profitable / tested</td>${profPerTF}</tr>
    </tbody>
  </table>
  <div style="margin-top:9px;font-size:10px;color:#303660">
    Hover cells for WR · trades · avg R:R &nbsp;·&nbsp; 📌 = pivot strategy &nbsp;·&nbsp; ${summary.total_strategies_tested} unique combos
  </div>
</div>`;
  }
}
