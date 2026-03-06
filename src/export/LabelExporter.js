export class LabelExporter {
  constructor(state) {
    this.state = state;
  }

  /** Full rich export for AI pattern analysis */
  exportPayload() {
    const s     = this.state;
    const stats = s.pnlStats ?? {};
    const bars  = s.bars;

    // Build context-rich marker list
    const richMarkers = s.markers.map(m => {
      const barIdx = bars.findIndex(b => Math.abs(b.t - m.t) < 120_000);
      const bar    = barIdx >= 0 ? bars[barIdx] : null;
      const macd   = s.macd[barIdx] ?? null;
      const ema9v  = s.ema9[barIdx]  ?? null;
      const ema21v = s.ema21[barIdx] ?? null;
      return {
        id:        m.id,
        t:         m.t,
        time:      new Date(m.t).toISOString(),
        kind:      m.kind,
        pane:      m.pane,
        source:    m.source ?? "user",
        bar:       bar ? { o: bar.o, h: bar.h, l: bar.l, c: bar.c } : null,
        context: {
          macd_hist:  macd?.hist   ?? null,
          macd_line:  macd?.macd   ?? null,
          macd_sig:   macd?.signal ?? null,
          ema9:       ema9v,
          ema21:      ema21v,
          ema_spread: (ema9v != null && ema21v != null) ? ema9v - ema21v : null,
        },
      };
    });

    return {
      exported_at: new Date().toISOString(),
      symbol:      s.symbol,
      timeframe:   s.timeframe,
      settings:    s.settings,
      stats: {
        trades:     stats.trades     ?? 0,
        wins:       stats.wins       ?? 0,
        losses:     stats.losses     ?? 0,
        winRate:    stats.winRate    ?? 0,
        totalPnl:   stats.totalPnl   ?? 0,
        avgPnl:     stats.avgPnl     ?? 0,
        bestTrade:  stats.bestTrade  ?? 0,
        worstTrade: stats.worstTrade ?? 0,
      },
      trades:   (stats.tradeList ?? []).map(tr => ({
        entryT:      tr.entryT,
        exitT:       tr.exitT,
        entryTime:   new Date(tr.entryT).toISOString(),
        exitTime:    new Date(tr.exitT).toISOString(),
        entryPrice:  tr.entryPrice,
        exitPrice:   tr.exitPrice,
        pnl:         tr.pnl,
        pct:         tr.pct,
        win:         tr.win,
      })),
      auto_signals: s.events.map(e => ({...e})),
      user_markers: richMarkers,
    };
  }

  downloadLabels() {
    const payload = this.exportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `labels_${payload.symbol}_${payload.timeframe}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

