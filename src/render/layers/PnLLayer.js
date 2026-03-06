/**
 * PnLLayer
 *
 * Pairs up user "My Signal" lane markers (buy → sell) to form hypothetical trades,
 * then draws:
 *   1. Shaded region between entry and exit on the price pane (green/red alpha fill)
 *   2. Win/loss P&L label mid-region
 *   3. Running cumulative P&L curve at the bottom edge of the price pane
 *
 * Also writes `scene.state.pnlStats` so the stats panel can read it.
 */

function nearestBar(allBars, t) {
  if (!allBars.length) return null;
  let best = allBars[0], bestDist = Math.abs(allBars[0].t - t);
  for (const b of allBars) {
    const d = Math.abs(b.t - t);
    if (d < bestDist) { best = b; bestDist = d; }
  }
  return best;
}

function pairTrades(markers, allBars, state) {
  const sorted  = [...markers].sort((a, b) => a.t - b.t);
  const trades  = [];
  let openBuy   = null;

  for (const m of sorted) {
    if (m.kind === "buy" && !openBuy) {
      openBuy = m;
    } else if (m.kind === "sell" && openBuy) {
      const entry = nearestBar(allBars, openBuy.t);
      const exit  = nearestBar(allBars, m.t);
      if (entry && exit) {
        const pnl    = exit.c - entry.c;
        const holdMs = Math.max(0, m.t - openBuy.t);

        // Capture indicator context at entry bar for strategy analysis
        const ei = state ? allBars.findIndex(b => b === entry) : -1;
        let entryContext = null;
        if (state && ei >= 0) {
          // 20-bar lookback window for statistical context
          const lookback = 20;
          const wStart  = Math.max(0, ei - lookback + 1);
          const winBars = allBars.slice(wStart, ei + 1);
          const winVols = (state.volume ?? []).slice(wStart, ei + 1);

          const sma20    = winBars.length ? winBars.reduce((s, b) => s + b.c, 0) / winBars.length : null;
          const r20High  = winBars.length ? Math.max(...winBars.map(b => b.h)) : null;
          const r20Low   = winBars.length ? Math.min(...winBars.map(b => b.l)) : null;
          const r20      = (r20High != null && r20Low != null && r20High > r20Low) ? r20High - r20Low : null;
          const avgVol   = winVols.length ? winVols.reduce((s, v) => s + (v.v ?? 0), 0) / winVols.length : null;
          const thisVol  = (state.volume ?? [])[ei]?.v ?? null;

          entryContext = {
            macd_hist:      state.macd[ei]?.hist                                      ?? null,
            ema_spread:     (state.ema9[ei] != null && state.ema21[ei] != null)
                              ? state.ema9[ei] - state.ema21[ei]
                              : null,
            candle_bull:    entry.c > entry.o,
            above_sma20:    sma20 != null ? entry.c > sma20 : null,
            price_vs_range: r20 != null ? (entry.c - r20Low) / r20 : null,
            vol_ratio:      (avgVol && avgVol > 0 && thisVol != null) ? thisVol / avgVol : null,
          };
        }

        trades.push({
          entryT: openBuy.t, exitT: m.t,
          entryPrice: entry.c, exitPrice: exit.c,
          pnl,
          pct: ((exit.c - entry.c) / entry.c) * 100,
          win: pnl > 0,
          holdMs,
          entryContext,
        });
      }
      openBuy = null;
    }
  }
  return trades;
}

export class PnLLayer {
  draw(ctx, scene) {
    const ps   = scene._priceScale;
    const pane = scene.panes.price;
    if (!ps || !pane) return;

    const laneMarkers = (scene.markers ?? []).filter(m => m.pane === "lane");
    const allBars     = scene.state.bars;
    const trades      = pairTrades(laneMarkers, allBars, scene.state);
    const [t0, t1]    = scene.xDomain;

    /* Store stats for the stats panel */
    const wins   = trades.filter(tr => tr.win);
    const losses = trades.filter(tr => !tr.win);
    const total  = trades.length;
    const totPnl = trades.reduce((s, tr) => s + tr.pnl, 0);

    const avg = (arr, fn) => arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;

    scene.state.pnlStats = {
      trades: total,
      wins: wins.length,
      losses: losses.length,
      winRate: total ? (wins.length / total * 100) : 0,
      totalPnl: totPnl,
      avgPnl: total ? totPnl / total : 0,
      bestTrade:  total ? Math.max(...trades.map(tr => tr.pnl)) : 0,
      worstTrade: total ? Math.min(...trades.map(tr => tr.pnl)) : 0,
      avgHoldMs:     avg(trades, t => t.holdMs),
      avgWinHoldMs:  avg(wins,   t => t.holdMs),
      avgLossHoldMs: avg(losses, t => t.holdMs),
      tradeList: trades,
    };

    /* ── Clip all drawing to price pane bounds ──────────────── */
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();

    /* ── Draw each trade region ─────────────────────────────── */
    for (const tr of trades) {
      const inView = tr.exitT >= t0 && tr.entryT <= t1;
      if (!inView) continue;

      const xEntry = ps.tToX(Math.max(tr.entryT, t0));
      const xExit  = ps.tToX(Math.min(tr.exitT,  t1));
      const w      = Math.max(1, xExit - xEntry);

      // Shade region
      ctx.fillStyle = tr.win
        ? "rgba(38, 166, 154, 0.10)"
        : "rgba(239, 83,  80,  0.10)";
      ctx.fillRect(xEntry, pane.y, w, pane.h);

      // Left/right border lines
      const bcol = tr.win ? "rgba(38,166,154,.40)" : "rgba(239,83,80,.40)";
      ctx.strokeStyle = bcol;
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xEntry, pane.y); ctx.lineTo(xEntry, pane.y + pane.h);
      ctx.moveTo(xExit,  pane.y); ctx.lineTo(xExit,  pane.y + pane.h);
      ctx.stroke();

      // P&L label if region is wide enough
      const midX = (xEntry + xExit) / 2;
      if (w > 40) {
        const sign   = tr.pnl >= 0 ? "+" : "";
        const label  = `${sign}${tr.pnl.toFixed(2)} (${sign}${tr.pct.toFixed(1)}%)`;
        const labelY = pane.y + 14;

        ctx.font         = "bold 10px monospace";
        ctx.textAlign    = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle    = tr.win ? "rgba(38,166,154,.85)" : "rgba(239,83,80,.85)";
        ctx.fillText(label, midX, labelY);
      }
    }
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";

    /* ── Running cumulative P&L curve ──────────────────────── */
    if (trades.length > 1) {
      this._drawCumulativePnl(ctx, scene, trades, pane, ps);
    }

    ctx.restore(); // end pane clip
  }

  _drawCumulativePnl(ctx, scene, trades, pane, ps) {
    const [t0, t1] = scene.xDomain;
    const stripH   = 28;
    const stripY   = pane.y + pane.h - stripH;
    const stripW   = pane.w;

    // Build cumulative step list (start point at t=first entry with cum=0)
    const points = [{ t: trades[0].entryT, cum: 0 }];
    let running = 0;
    for (const tr of trades) {
      running += tr.pnl;
      points.push({ t: tr.exitT, cum: running });
    }

    // Compute value range across ALL points (not just visible) so scale is stable
    const values = points.map(p => p.cum);
    const vMin   = Math.min(0, ...values);
    const vMax   = Math.max(vMin + 0.001, ...values);
    const vRange = vMax - vMin;

    // Linear interpolate cumulative value at time t (step function — value stays
    // constant between trade exits)
    const interpCum = (t) => {
      if (t <= points[0].t)  return points[0].cum;
      if (t >= points[points.length-1].t) return points[points.length-1].cum;
      for (let i = 1; i < points.length; i++) {
        if (t < points[i].t) return points[i-1].cum;
      }
      return running;
    };

    const tx = (t) => pane.x + ((t - t0) / (t1 - t0)) * stripW;
    const vy = (v) => stripY + stripH - ((v - vMin) / vRange) * stripH;

    // Background
    ctx.fillStyle = "#0e1220";
    ctx.fillRect(pane.x, stripY, stripW, stripH);

    // Zero line
    const y0 = vy(0);
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(pane.x, y0); ctx.lineTo(pane.x + stripW, y0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Build visible segment: interpolate at t0, then add all interior points in
    // range, then interpolate at t1.  This ensures the curve always fills the
    // full width of the strip without any gap or phantom close.
    const seg = [];
    seg.push({ t: t0, cum: interpCum(t0) });
    for (const p of points) {
      if (p.t > t0 && p.t < t1) seg.push(p);
    }
    seg.push({ t: t1, cum: interpCum(t1) });

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, stripY, 0, stripY + stripH);
    gradient.addColorStop(0, running >= 0 ? "rgba(38,166,154,.40)" : "rgba(239,83,80,.40)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");

    ctx.beginPath();
    ctx.moveTo(tx(seg[0].t), vy(seg[0].cum));
    for (let i = 1; i < seg.length; i++) {
      // Step function — horizontal then vertical (like a P&L equity curve)
      ctx.lineTo(tx(seg[i].t), vy(seg[i-1].cum));  // horizontal step
      ctx.lineTo(tx(seg[i].t), vy(seg[i].cum));    // vertical drop/rise
    }
    // Close down to bottom of strip and back to start
    ctx.lineTo(tx(seg[seg.length-1].t), stripY + stripH);
    ctx.lineTo(tx(seg[0].t),            stripY + stripH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line
    ctx.strokeStyle = running >= 0 ? "#26a69a" : "#ef5350";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    let started = false;
    for (const pt of points) {
      if (pt.t < t0 || pt.t > t1) { started = false; continue; }
      const x = tx(pt.t);
      const y = vy(pt.cum);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Label: total P&L
    const sign  = running >= 0 ? "+" : "";
    ctx.font      = "bold 9px monospace";
    ctx.fillStyle = running >= 0 ? "#26a69a" : "#ef5350";
    ctx.textBaseline = "top";
    ctx.fillText(`P&L ${sign}${running.toFixed(2)}`, pane.x + 4, stripY + 2);
    ctx.textBaseline = "alphabetic";
  }
}
