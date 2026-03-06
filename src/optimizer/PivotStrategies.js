/**
 * PivotStrategies.js — Built-in pivot-point trading strategies for the optimizer.
 *
 * Pure data module — no imports, no DOM, no indicator math.
 * All conditions reference condition-IDs evaluated by SignalEngine.evalCondition().
 *
 * Strategies are crypto-focused (Kraken Pro fee model: 0.40% entry / 0.25% exit).
 * Supports: classic, woodie, camarilla pivot formula types.
 *
 * Usage:
 *   import { getPivotStrategies } from '../optimizer/PivotStrategies.js';
 *   const strats = getPivotStrategies();  // → strategy[]
 */

// ─── Canonical configs ────────────────────────────────────────────────────────

const FEES_KRAKEN = { exchange: "Kraken Pro", entry_pct: 0.40, exit_pct: 0.25 };
const RISK_DEFAULT = {
  method: "fixed_pct",
  account_size: 1000,
  risk_per_trade_pct: 1.0,
  max_open_positions: 1,
  max_drawdown_pct: 10.0,
};

function _meta(name, notes = "") {
  return {
    schema_version: "1.0",
    meta: {
      name,
      symbol: "UNKNOWN",
      timeframe: "15m",
      created: new Date().toISOString(),
      notes,
    },
  };
}

// ─── Exported strategies ──────────────────────────────────────────────────────

/**
 * Returns the 8 built-in pivot strategies used by the optimizer's auto-pivot pass.
 * @returns {object[]}
 */
export function getPivotStrategies() {
  const fees = FEES_KRAKEN;
  const risk = RISK_DEFAULT;
  const meta = _meta;

  return [
    // ── 1: Classic Pivot Breakout Long ───────────────────────────────────────
    {
      ...meta("Pivot: Classic R1 Breakout Long",
              "Close clears prev-24h R1 on volume surge with trend confirmation"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "r1" },
            label: "Close > Daily R1 (classic pivot)" },
          { id: "volume_spike",  enabled: true, params: { multiplier: 1.5 },
            label: "Volume spike 1.5× avg" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 22 },
            label: "ADX ≥ 22 (trend confirmed)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.8 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 64 },
      risk, fees,
    },

    // ── 2: Classic Pivot Breakout Short ──────────────────────────────────────
    {
      ...meta("Pivot: Classic S1 Breakdown Short",
              "Close breaks below prev-24h S1 with volume and trend confirmation"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_below_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s1" },
            label: "Close < Daily S1 (classic pivot)" },
          { id: "volume_spike",  enabled: true, params: { multiplier: 1.5 },
            label: "Volume spike 1.5×" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 22 },
            label: "ADX ≥ 22" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.8 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 64 },
      risk, fees,
    },

    // ── 3: Camarilla Mean-Reversion Long ─────────────────────────────────────
    {
      ...meta("Pivot: Camarilla S3 Mean-Reversion Long",
              "Touch of S3 Camarilla level with RSI oversold — crypto bounce play"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "camarilla", period_hours: 24, level: "s3", tolerance: 0.5 },
            label: "Price near Camarilla S3 (±0.5 ATR)" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 20, max: 38 },
            label: "RSI oversold zone (20–38)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },

    // ── 4: Camarilla Mean-Reversion Short ────────────────────────────────────
    {
      ...meta("Pivot: Camarilla R3 Mean-Reversion Short",
              "Price stalls at R3 Camarilla with overbought RSI — crypto rejection play"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "camarilla", period_hours: 24, level: "r3", tolerance: 0.5 },
            label: "Price near Camarilla R3 (±0.5 ATR)" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 62, max: 80 },
            label: "RSI overbought zone (62–80)" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },

    // ── 5: Woodie Pivot PP Bounce Long ────────────────────────────────────────
    {
      ...meta("Pivot: Woodie PP Bounce Long",
              "Price holds above Woodie PP with EMA trend aligned — momentum continuation"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "woodie", period_hours: 24, level: "pp" },
            label: "Close > Woodie PP" },
          { id: "ema_above_slow", enabled: true, params: { fast: 9, slow: 21 },
            label: "EMA 9 > EMA 21" },
          { id: "rsi_in_zone", enabled: true, params: { period: 14, min: 45, max: 65 },
            label: "RSI 45–65" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 1.5 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 48 },
      risk, fees,
    },

    // ── 6: Vol Expansion Breakout Long ───────────────────────────────────────
    {
      ...meta("Pivot: Vol Expansion Breakout Long",
              "ATR expanding + close above R1 + ADX: high-conviction breakout for crypto"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_above_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "r1" },
            label: "Close > Daily R1" },
          { id: "atr_breakout",  enabled: true,
            params: { period: 14, multiplier: 1.5, lookback: 20 },
            label: "ATR expanding (breakout momentum)" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 25 },
            label: "ADX ≥ 25" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 72 },
      risk, fees,
    },

    // ── 7: Vol Expansion Breakdown Short ─────────────────────────────────────
    {
      ...meta("Pivot: Vol Expansion Breakdown Short",
              "ATR expanding + close below S1 + ADX: high-conviction breakdown"),
      entry: {
        direction: "short", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_below_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s1" },
            label: "Close < Daily S1" },
          { id: "atr_breakout",  enabled: true,
            params: { period: 14, multiplier: 2.0, lookback: 20 },
            label: "ATR expanding (breakdown momentum)" },
          { id: "adx_trending",  enabled: true, params: { period: 14, threshold: 25 },
            label: "ADX ≥ 25" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 3.0 }, max_bars: 72 },
      risk, fees,
    },

    // ── 8: Classic Pivot Zone Mean-Reversion Long ─────────────────────────────
    {
      ...meta("Pivot: Classic S2 Zone Bounce Long",
              "Price pinches S2 on RSI exhaustion + MACD turn — bounce toward PP"),
      entry: {
        direction: "long", logic: "AND", confirm_bars: 1,
        conditions: [
          { id: "price_near_pivot", enabled: true,
            params: { type: "classic", period_hours: 24, level: "s2", tolerance: 0.6 },
            label: "Price near Classic S2 (±0.6 ATR)" },
          { id: "rsi_oversold",  enabled: true, params: { period: 14, level: 30 },
            label: "RSI crosses above 30" },
          { id: "macd_hist_pos", enabled: true, params: { fast: 12, slow: 26, sig: 9 },
            label: "MACD hist turns positive" },
        ],
      },
      exit: { stop_loss: { type: "atr", params: { period: 14, multiplier: 2.0 } },
              take_profit: { type: "rr", ratio: 2.5 }, max_bars: 40 },
      risk, fees,
    },
  ];
}
