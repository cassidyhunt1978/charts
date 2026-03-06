/**
 * LiveProvider.js — connects to the MarketMind REST API
 *
 * API base: http://172.16.1.92:8012
 *
 *   GET /symbols
 *     → { status, count, symbols: [{id, symbol, name, exchange, ...}] }
 *
 *   GET /candles
 *     ?symbol (required), limit (max 10 000), days_back (max 365)
 *     start_date, end_date (YYYY-MM-DD, no range limit), include_indicators
 *
 *   Date-window pagination is used to fetch more than 10 k candles: multiple
 *   requests are issued in WINDOW_DAYS-sized date buckets and merged.
 */

const API = "http://172.16.1.92:8012";

// Yield control back to the browser (one event-loop turn) so the UI stays
// responsive during long-running fetch + processing operations.
const _yield = () => new Promise(r => setTimeout(r, 0));

// ── EMA helper ────────────────────────────────────────────────────────────────
function _ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  const seed = values.slice(0, period).reduce((a, v) => a + v, 0) / period;
  let prev = seed;
  for (let i = period - 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ── Local MACD computation ───────────────────────────────────────────────────
export function _computeMacd(bars) {
  const closes = bars.map(b => b.c);
  const ema12  = _ema(closes, 12);
  const ema26  = _ema(closes, 26);

  // macdLine meaningful only where both EMAs are non-null (i >= 25)
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );

  // signal: EMA-9 of macdLine — computed only over non-null slice
  const signalArr = new Array(bars.length).fill(null);
  const validStart = macdLine.findIndex(v => v !== null);
  if (validStart >= 0) {
    const validSlice = macdLine.slice(validStart);
    const sigSlice   = _ema(validSlice, 9);
    sigSlice.forEach((v, i) => { signalArr[validStart + i] = v; });
  }

  return bars.map((b, i) => {
    const m = macdLine[i];
    const s = signalArr[i];
    return {
      t:      b.t,
      macd:   m   ?? 0,
      signal: s   ?? 0,
      hist:   (m !== null && s !== null) ? m - s : 0,
    };
  });
}

// ── Map raw API candle array → internal format ───────────────────────────────
function _mapCandles(raw) {
  const bars   = [];
  const volume = [];

  for (const c of raw) {
    const t = new Date(c.timestamp).getTime();
    bars.push({
      t,
      o: +c.open,
      h: +c.high,
      l: +c.low,
      c: +c.close,
    });
    volume.push({ t, v: +c.volume });
  }

  // Ensure ascending time order (API returns descending for latest-first)
  if (bars.length > 1 && bars[0].t > bars[1].t) {
    bars.reverse();
    volume.reverse();
  }

  return { bars, volume };
}

// ── Public: fetch symbol list ────────────────────────────────────────────────
export async function fetchSymbols() {
  const res  = await fetch(`${API}/symbols`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.symbols ?? []);
  return list.map(s => ({
    symbol:   s.symbol,
    name:     s.name ?? s.symbol,
    exchange: s.exchange ?? "",
  }));
}

// ── Core bulk fetch ───────────────────────────────────────────────────────────
/**
 * _fetchAndPack(symbol, daysBack, progressCb)
 *
 * Fetches candles via the chunked /candles endpoint (date-window pagination),
 * deduplicates, sorts ascending, and returns the standard provider shape.
 *
 * @param {string}   symbol
 * @param {number}   daysBack
 * @param {function} [progressCb]  (done, total) => void
 * @returns {Promise<{ bars, volume, macd, markers:[], events:[], positions:[] }>}
 */
async function _fetchAndPack(symbol, daysBack, progressCb = null) {
  const raw = await _fetchChunked(symbol, daysBack, progressCb);

  // Heavy synchronous work — yield before each step so the browser can repaint
  await _yield();
  const seen   = new Set();
  const unique = raw.filter(c => seen.has(c.timestamp) ? false : seen.add(c.timestamp));
  // String compare is faster than Date construction on 500k items
  unique.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  await _yield();
  const { bars, volume } = _mapCandles(unique);

  await _yield();
  const macd = _computeMacd(bars);

  if (bars.length > 1) {
    const spanDays = ((bars[bars.length - 1].t - bars[0].t) / 86_400_000).toFixed(1);
    console.info(`[LiveProvider] ${symbol}: ${bars.length.toLocaleString()} bars · ${spanDays}d span`);
  }

  return { bars, volume, macd, markers: [], events: [], positions: [] };
}

// ── Parallel chunked loader ─────────────────────────────────────────────
async function _fetchChunked(symbol, daysBack, progressCb) {
  // 6-day windows: 6 × 1440 = 8640 candles/request < 10 k API cap
  const WINDOW_DAYS = Math.min(6, daysBack);
  // Concurrent requests per batch — keeps browser responsive and avoids
  // hammering the server.  8 is a good balance: fast but not abusive.
  const BATCH_SIZE  = 8;
  const now = new Date();
  const fmt = dt => dt.toISOString().slice(0, 10);

  // Build all date windows oldest → newest
  const windows = [];
  for (let d = daysBack; d > 0; d -= WINDOW_DAYS) {
    const ws  = Math.min(d, WINDOW_DAYS);
    const end = new Date(now.getTime() - (d - ws) * 86_400_000);
    const st  = new Date(now.getTime() - d       * 86_400_000);
    windows.push({ start: fmt(st), end: fmt(end) });
  }

  const allRaw = [];
  let   fetched = 0;

  // Fire requests in parallel batches; yield between batches so the browser
  // can update the progress bar and stay interactive.
  for (let i = 0; i < windows.length; i += BATCH_SIZE) {
    const batch = windows.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(win => {
        const url = `${API}/candles?symbol=${encodeURIComponent(symbol)}&limit=10000` +
                    `&start_date=${win.start}&end_date=${win.end}&include_indicators=false`;
        return fetch(url).then(r => r.ok ? r.json() : Promise.resolve([]));
      })
    );

    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allRaw.push(...r.value);
      }
    }

    fetched += batch.length;
    if (progressCb) progressCb(fetched, windows.length);
    await _yield();  // let the browser breathe between batches
  }

  // Last-resort fallback if everything failed
  if (!allRaw.length) {
    try {
      const res = await fetch(`${API}/candles?symbol=${encodeURIComponent(symbol)}&limit=10000&include_indicators=false`);
      const raw = await res.json();
      if (Array.isArray(raw)) allRaw.push(...raw);
    } catch (_) {}
  }

  return allRaw;
}
// ── Public: provider factory ─────────────────────────────────────────────────
/**
 * makeLiveProvider(symbol, daysBack, progressCb)
 *
 * Returns a provider function that fetches the last `daysBack` days of 1-minute
 * candles via a single /candles/bulk request.  No chunking or pagination needed.
 *
 * @param {string}   symbol     e.g. "BTC"
 * @param {number}   daysBack   days of history (default 30)
 * @param {function} [progressCb]  (done, total) => void
 */
export function makeLiveProvider(symbol, daysBack = 30, progressCb = null) {
  return () => _fetchAndPack(symbol, daysBack, progressCb);
}

// ── Public: fetch maximum available history ───────────────────────────────────
/**
 * fetchAllAvailable(symbol, progressCb)
 *
 * Fetches every stored candle for a symbol via a single /candles/bulk request
 * with no date or limit constraints.  Returns the same { bars, volume, macd }
 * shape as makeLiveProvider.
 *
 * Use for optimizer runs where sample size is critical.
 *
 * @param {string}   symbol
 * @param {function} [progressCb]  (barsLoaded: number, total: 1) => void
 * @returns {Promise<{ bars, volume, macd }>}
 */
export async function fetchAllAvailable(symbol, progressCb = null) {
  // Fetch ~2 years by using date-windowed chunking (no days_back cap because
  // _fetchChunked uses start_date/end_date which has no server-side range limit).
  return _fetchAndPack(symbol, 730, progressCb);
}

// ── Public: parallel multi-symbol loader ─────────────────────────────────────
/**
 * fetchMultiSymbol(symbols, daysBack, progressCb)
 *
 * Parallel-fetches multiple symbols via /candles/bulk and returns a map of
 * { [symbol]: { bars, volume, macd } }.  Failed symbols are logged and omitted.
 *
 * @param {string[]}  symbols
 * @param {number}    [daysBack=90]
 * @param {function}  [progressCb]  (completed, total, symbol) => void
 */
export async function fetchMultiSymbol(symbols, daysBack = 90, progressCb = null) {
  const total   = symbols.length;
  let   done    = 0;
  const results = {};

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      results[sym] = await _fetchAndPack(sym, daysBack);
    } catch (err) {
      console.warn(`[LiveProvider] fetchMultiSymbol: ${sym} failed —`, err.message);
    } finally {
      done++;
      if (progressCb) progressCb(done, total, sym);
    }
  }));

  return results;
}

// ── Public: optimizer-grade provider factory ──────────────────────────────────
/**
 * makeOptimizerProvider(symbol, opts)
 *
 * Returns a provider that fetches the maximum available history (no date or
 * limit constraints) via a single /candles/bulk request.
 *
 * @param {string}  symbol
 * @param {object}  [opts]
 * @param {number}  [opts.daysBack]   if set, limit to this many days; otherwise all
 * @param {function}[opts.progressCb]
 */
export function makeOptimizerProvider(symbol, opts = {}) {
  const { daysBack = null, progressCb = null } = opts;
  return async function optimizerProvider() {
    const days = daysBack ?? 730;
    const data = await _fetchAndPack(symbol, days, progressCb);
    console.info(`[OptimizerProvider] ${symbol}: ${data.bars.length.toLocaleString()} bars available`);
    return data;
  };
}
