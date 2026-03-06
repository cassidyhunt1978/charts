/**
 * StrategyOverlay.js
 *
 * Background strategy loader: fetches stored strategies from the trading app
 * DB, runs runSignalScan on the current bars for each, and stores per-strategy
 * signal arrays so SignalsLayer can render them as a secondary overlay.
 *
 * API endpoints used:
 *   GET  http://172.16.1.92:8020/charts-strategies  → [{id, strategy_name, entry_rules, exit_rules, risk_params}]
 *   POST http://172.16.1.92:8020/import_charts_strategy  → import a new strategy
 */

import { runSignalScan } from '../signals/SignalEngine.js';

const TRADING_API = 'http://172.16.1.92:8020';

// Palette of distinct colours for per-strategy signal overlays
const OVERLAY_COLOURS = [
  '#f59e0b', '#38bdf8', '#a78bfa', '#fb7185', '#4ade80',
  '#f472b6', '#22d3ee', '#facc15', '#c084fc', '#86efac',
];

export class StrategyOverlay {
  constructor() {
    this._strategies  = [];           // [{id, strategy_name, entry_rules, exit_rules, risk_params, colour, enabled}]
    this._signals     = new Map();    // id → [{t, direction, price, _bgStrategy, _colour}]
    this._loading     = false;
    this.onUpdate     = null;         // () => void — called when signals change
  }

  get isLoading()  { return this._loading; }
  get strategies() { return this._strategies; }

  /**
   * Fetch all stored strategies from trading app, run signal scans on bars[],
   * store results.  Calls this.onUpdate() when done.
   *
   * @param {object[]} bars  candle array {t,o,h,l,c}
   */
  async load(bars) {
    if (!bars?.length || this._loading) return;
    this._loading = true;
    this._strategies = [];
    this._signals.clear();

    try {
      const res = await fetch(`${TRADING_API}/charts-strategies`);
      if (!res.ok) {
        console.warn(`[StrategyOverlay] GET /charts-strategies → HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.strategies ?? []);
      console.log('[StrategyOverlay] Loaded strategies:', list.length);

      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const colour = OVERLAY_COLOURS[i % OVERLAY_COLOURS.length];
        const entry = {
          id:            s.id ?? s.strategy_name,
          strategy_name: s.strategy_name,
          entry_rules:   s.entry_rules,
          exit_rules:    s.exit_rules,
          risk_params:   s.risk_params,
          colour,
          enabled: true,
        };
        this._strategies.push(entry);

        // Build a minimal strategy object compatible with runSignalScan
        if (!s.entry_rules) continue;
        try {
          const stratObj = this._buildScanStrategy(s);
          const { signals } = runSignalScan(bars, stratObj);
          const tagged = signals.map(sig => ({
            ...sig,
            _bgStrategy: s.strategy_name,
            _bgId:       entry.id,
            _colour:     colour,
          }));
          this._signals.set(entry.id, tagged);
          console.log('[StrategyOverlay] Generated signals:', s.strategy_name, tagged.length);
        } catch (err) {
          console.warn('[StrategyOverlay] Signal scan failed for', s.strategy_name, '—', err.message);
        }

        // Yield between strategies to keep UI responsive
        await new Promise(r => setTimeout(r, 0));
      }

      this.onUpdate?.();
    } catch (err) {
      console.warn('[StrategyOverlay] Load failed:', err.message);
    } finally {
      this._loading = false;
    }
  }

  /** Toggle a strategy's overlay on/off */
  toggle(id) {
    const s = this._strategies.find(s => s.id === id);
    if (s) {
      s.enabled = !s.enabled;
      this.onUpdate?.();
    }
  }

  /**
   * Return all signals from enabled strategies, merged into a single flat array.
   * Each signal has an extra `_colour` and `_bgStrategy` field for rendering.
   */
  getMergedSignals() {
    const out = [];
    for (const s of this._strategies) {
      if (!s.enabled) continue;
      const sigs = this._signals.get(s.id) ?? [];
      out.push(...sigs);
    }
    return out;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _buildScanStrategy(s) {
    const entry = typeof s.entry_rules === 'string'
      ? JSON.parse(s.entry_rules)
      : (s.entry_rules ?? {});
    const exit = typeof s.exit_rules === 'string'
      ? JSON.parse(s.exit_rules)
      : (s.exit_rules ?? {});
    const risk = typeof s.risk_params === 'string'
      ? JSON.parse(s.risk_params)
      : (s.risk_params ?? {});

    // If entry_rules is already a full strategy object (has schema_version), use it directly
    if (entry.schema_version && entry.entry) return entry;

    return {
      schema_version: '1.0',
      meta: { name: s.strategy_name, symbol: 'UNKNOWN', timeframe: '15m' },
      entry: entry.direction
        ? entry
        : { direction: 'long', logic: 'AND', confirm_bars: 1, conditions: [], ...entry },
      exit: exit.stop_loss
        ? exit
        : { stop_loss: { type: 'atr', params: { period: 14, multiplier: 1.5 } },
            take_profit: { type: 'ratio', params: { ratio: 2.0 } },
            max_bars: 48, ...exit },
      risk: { method: 'fixed_pct', account_size: 1000, risk_per_trade_pct: 1.0,
              max_open_positions: 1, max_drawdown_pct: 10.0, ...risk },
      fees: { exchange: 'Kraken Pro', entry_pct: 0.40, exit_pct: 0.25 },
    };
  }
}

/**
 * POST a strategy to the trading app's import endpoint.
 *
 * @param {object} strategy  charts strategy object (from signalEditor/optimizer)
 * @param {object} stats     trade stats from runSignalScan
 * @returns {Promise<object>} response JSON
 */
export async function exportStrategyToTradingApp(strategy, stats) {
  const payload = {
    source_file:       'charts_optimizer',
    strategy_name:     strategy.meta?.name ?? `charts_${Date.now()}`,
    entry_rules:       strategy.entry,
    exit_rules:        strategy.exit,
    risk_params:       strategy.risk,
    backtest_summary:  stats
      ? {
          profit_factor:  stats.profit_factor,
          win_rate:        stats.win_rate,
          trade_count:     stats.total,
          net_pnl_usd:     stats.net_pnl_usd,
          max_drawdown_usd: stats.max_drawdown_usd,
          avg_rr:          stats.avg_rr,
        }
      : null,
  };

  console.log('[TradingBridge] Exporting to trading app:', payload);

  const res = await fetch(`${TRADING_API}/import_charts_strategy`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const result = await res.json();
  console.log('[TradingBridge] Export success:', result);
  return result;
}
