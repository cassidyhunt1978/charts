/**
 * OptimizerEngine.js — Main orchestrator for strategy optimization.
 *
 * Wraps the full 8-pass optimizer (SignalOptimizer.js) in a class-based
 * facade that matches the core/Engine.js style:
 *  - Manages abort controller lifecycle
 *  - Normalises opts (defaulting, validation)
 *  - Console.group logging per TF and pass
 *  - Exposes clean public callbacks: onProgress, onComplete, onError
 *
 * This module lives in src/optimizer/ and imports the heavy optimizer logic
 * from src/signals/SignalOptimizer.js so both can coexist during the
 * incremental migration.  Once SignalOptimizer.js is thinned to a re-export
 * shim it can be removed entirely.
 *
 * Example:
 *   const oEng = new OptimizerEngine();
 *   oEng.onProgress = ({ phase, pct, label }) => updateProgressBar(pct, label);
 *   oEng.onComplete = result => showResults(result);
 *   await oEng.run(bars, strategy, { multiTF: true, allTfs: ['1m','5m','1h','4h'] });
 */

import { optimizeStrategyAsync, strategyDiff } from '../signals/SignalOptimizer.js';
import { getPivotStrategies }                   from './PivotStrategies.js';
import { resample, tfToMinutes }                from '../util/Aggregator.js';
import { runSignalScan }                        from '../signals/SignalEngine.js';

// ─── All standard report TFs, in ascending resolution order ──────────────────
export const ALL_TFS = [
  { tf: '1m',  min: 1    },
  { tf: '5m',  min: 5    },
  { tf: '15m', min: 15   },
  { tf: '1h',  min: 60   },
  { tf: '4h',  min: 240  },
  { tf: '1d',  min: 1440 },
];

// ─── Default optimizer opts ───────────────────────────────────────────────────
const DEFAULTS = {
  topN:           5,
  autoPivot:      true,
  multiTF:        true,
  preferHigherTF: true,
  allTfs:         true,          // test all 6 TFs in runMultiTFScan
  runPivots:      true,          // run pass7 auto-pivot
  minSQS:         45,
  baseTF:         '15m',
  feePct:         0.65,          // round-trip %
  riskPct:        1.0,
  rrTarget:       2.0,
};

// ─── OptimizerEngine class ────────────────────────────────────────────────────

export class OptimizerEngine {
  /**
   * @param {object} [opts]
   * @param {function} [opts.onProgress] - ({ phase, pct, label, detail }) => void
   * @param {function} [opts.onComplete] - (result) => void
   * @param {function} [opts.onError]    - (err) => void
   */
  constructor({ onProgress, onComplete, onError } = {}) {
    this._abort    = null;          // AbortController | null
    this._status   = 'idle';        // 'idle' | 'running' | 'done' | 'cancelled' | 'error'
    this._result   = null;
    this._opts     = null;

    this.onProgress = onProgress ?? null;
    this.onComplete = onComplete ?? null;
    this.onError    = onError    ?? null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  get status()     { return this._status; }
  get isRunning()  { return this._status === 'running'; }
  get lastResult() { return this._result; }

  /**
   * Cancel a running optimization immediately.
   * Safe to call even when idle.
   */
  cancel() {
    if (this._abort) {
      this._abort.abort();
      this._status = 'cancelled';
      console.info('[OptimizerEngine] Cancelled by user.');
    }
  }

  /**
   * Run the full optimization pipeline.
   *
   * @param {object[]} bars      - 1-minute OHLCV bar array (raw data)
   * @param {object}   strategy  - seed strategy (entry/exit/risk/fees)
   * @param {object}   [runOpts] - override defaults (see DEFAULTS above)
   * @returns {Promise<OptimizerResult>}
   */
  async run(bars, strategy, runOpts = {}) {
    if (this.isRunning) {
      console.warn('[OptimizerEngine] Already running — call cancel() first.');
      return null;
    }

    const opts = { ...DEFAULTS, ...runOpts };
    this._opts   = opts;
    this._status = 'running';
    this._result = null;
    this._abort  = new AbortController();

    const baseTFMin = tfToMinutes(opts.baseTF) ?? 15;

    console.group(`[OptimizerEngine] Run — ${opts.baseTF} | topN=${opts.topN} | allTFs=${opts.allTfs}`);
    console.debug('Opts:', opts);
    console.debug('Bars:', bars.length, '| strategy:', strategy?.meta?.name ?? '(unnamed)');

    // Validate bar count before launching
    if (!bars?.length) {
      const err = new Error('No bars provided to optimizer');
      this._status = 'error';
      this._emitError(err);
      console.groupEnd();
      return null;
    }

    // Log per-TF bar counts upfront
    if (opts.allTfs) {
      console.group('[OptimizerEngine] TF bar counts (before resample):');
      for (const { tf, min } of ALL_TFS) {
        if (min < baseTFMin) { console.debug(`  ${tf}: skipped (below base TF)`); continue; }
        const resampled = resample(bars, min);
        console.debug(`  ${tf}: ${resampled.length} bars`);
      }
      console.groupEnd();
    }

    const phaseLabel = {
      0:   'P0 conditions',
      1:   'P1 entry params',
      2:   'P2 exit params',
      3:   'P3 dir/logic',
      '3b':'P3b gate inject',
      4:   'P4 walk-forward',
      5:   'P5 SQS',
      6:   'P6 ensemble',
      7:   'P7 auto-pivot',
      8:   'P8 multi-TF',
    };

    try {
      const result = await optimizeStrategyAsync(bars, strategy, {
        topN:           opts.topN,
        signal:         this._abort.signal,
        autoPivot:      opts.autoPivot && opts.runPivots,
        multiTF:        opts.multiTF   && opts.allTfs,
        preferHigherTF: opts.preferHigherTF,
        baseTF:         opts.baseTF,
        progressCb: ({ phase, tested, total }) => {
          const label  = phaseLabel[phase] ?? `Pass ${phase}`;
          const pct    = (total && total !== '?') ? Math.round((tested / +total) * 100) : -1;
          const detail = `${tested}${total !== '?' ? `/${total}` : ''} combos`;
          this._emitProgress({ phase, pct, label, detail });
        },
      });

      if (this._abort.signal.aborted) {
        this._status = 'cancelled';
        console.info('[OptimizerEngine] Aborted after run completed.');
        console.groupEnd();
        return null;
      }

      // Attach opts snapshot + pivot strategies list to result for report use
      result._runOpts      = opts;
      result._pivotStrats  = opts.runPivots ? getPivotStrategies() : [];
      result._baseTFMin    = baseTFMin;

      // Log summary
      const top = result.topResults[0];
      const ps  = result.passStats;
      console.group('[OptimizerEngine] Result summary:');
      console.debug(`  Best PF : ${top?.stats?.profit_factor?.toFixed(3) ?? '–'}`);
      console.debug(`  Win rate: ${top?.stats?.win_rate ?? '–'}%`);
      console.debug(`  Trades  : ${top?.stats?.total ?? '–'}`);
      console.debug(`  Profitable: ${ps.foundProfitable}`);
      console.debug(`  Elapsed : ${ps.elapsedMs}ms`);
      if (ps.multiTFStats) {
        const mtf = ps.multiTFStats;
        console.debug(`  Multi-TF: ${mtf.tfs.length} TFs with trades | avg PF ${mtf.avg_profit_factor}`);
        if (mtf.all_zero) console.warn('  ⚠ All TFs returned 0 trades!');
        for (const tfEntry of (mtf.per_tf ?? [])) {
          const flag = tfEntry.zero_signals ? `0 trades (${tfEntry.reason})` : `${tfEntry.stats?.total} trades`;
          console.debug(`    ${tfEntry.tf}: ${flag}`);
        }
      }
      console.groupEnd();
      console.groupEnd();

      this._status = 'done';
      this._result = result;
      this._emitComplete(result);
      return result;

    } catch (err) {
      if (err.name === 'AbortError' || this._abort?.signal.aborted) {
        this._status = 'cancelled';
        console.info('[OptimizerEngine] Cancelled (AbortError).');
      } else {
        this._status = 'error';
        console.error('[OptimizerEngine] Error:', err);
        this._emitError(err);
      }
      console.groupEnd();
      return null;
    } finally {
      this._abort = null;
    }
  }

  /**
   * Run a quick single-pass backtest of a single strategy across all TFs.
   * Used for the "Quick Scan" button in OptimizerPanel without the full 8-pass run.
   *
   * @param {object[]} bars
   * @param {object}   strategy
   * @param {string[]} [tfs] - subset of ['1m','5m','15m','1h','4h','1d']
   * @returns {Promise<{tf,bars,trades,stats}[]>}
   */
  async quickScanAllTFs(bars, strategy, tfs = ALL_TFS.map(t => t.tf)) {
    const results = [];
    const targets = ALL_TFS.filter(t => tfs.includes(t.tf));

    console.group('[OptimizerEngine] quickScanAllTFs');
    for (const { tf, min } of targets) {
      const tfBars = resample(bars, min);
      if (tfBars.length < 50) {
        console.debug(`  ${tf}: skip (${tfBars.length} bars)`);
        continue;
      }
      try {
        const { stats } = runSignalScan(tfBars, strategy);
        console.debug(`  ${tf}: trades=${stats?.total ?? 0} PF=${stats?.profit_factor?.toFixed(3) ?? '–'} bars=${tfBars.length}`);
        results.push({ tf, min, bars: tfBars.length, trades: stats?.total ?? 0, stats });
      } catch (err) {
        console.warn(`  ${tf}: error —`, err?.message);
        results.push({ tf, min, bars: tfBars.length, trades: 0, stats: null, error: err?.message });
      }
    }
    console.groupEnd();
    return results;
  }

  /**
   * Compare original vs optimized strategy and return human-readable diff.
   * Thin wrapper around strategyDiff() for panel use.
   * @returns {{ label, from, to }[]}
   */
  diff(original, optimized) {
    return strategyDiff(original, optimized);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  _emitProgress(info) {
    if (typeof this.onProgress === 'function') {
      try { this.onProgress(info); } catch (_) { /* never crash the optimizer */ }
    }
  }

  _emitComplete(result) {
    if (typeof this.onComplete === 'function') {
      try { this.onComplete(result); } catch (_) {}
    }
  }

  _emitError(err) {
    if (typeof this.onError === 'function') {
      try { this.onError(err); } catch (_) {}
    }
  }
}

// ─── Factory convenience ──────────────────────────────────────────────────────

/**
 * Create a pre-wired OptimizerEngine instance with callback shortcuts.
 * @param {object} callbacks - { onProgress, onComplete, onError }
 * @returns {OptimizerEngine}
 */
export function createOptimizerEngine(callbacks = {}) {
  return new OptimizerEngine(callbacks);
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

export { getPivotStrategies }  from './PivotStrategies.js';
export { strategyDiff }        from '../signals/SignalOptimizer.js';
export { ALL_TFS as ALL_REPORT_TFS };
