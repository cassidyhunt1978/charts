/**
 * OptimizeWorker.js — Web Worker wrapper for SignalOptimizer
 *
 * Runs the full optimizer on a background thread so the UI stays
 * responsive.  The worker communicates via postMessage:
 *
 * Main → Worker:
 *   { type: "run", bars, strategy, opts }
 *
 * Worker → Main:
 *   { type: "progress", phase, tested, total, label }  — incremental updates
 *   { type: "done",     result }                        — final result
 *   { type: "error",    message }                       — on exception
 */

import { optimizeStrategyAsync } from "./SignalOptimizer.js";

self.onmessage = async function (e) {
  const { type, bars, strategy, opts } = e.data;
  if (type !== "run") return;

  try {
    const result = await optimizeStrategyAsync(bars, strategy, {
      ...opts,
      progressCb: ({ phase, tested, total }) => {
        self.postMessage({ type: "progress", phase, tested, total });
      },
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message ?? String(err) });
  }
};
