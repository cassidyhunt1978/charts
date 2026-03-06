import { GridLayer }            from "./layers/GridLayer.js";
import { DecisionLaneLayer }     from "./layers/DecisionLaneLayer.js";
import { CandlesLayer }          from "./layers/CandlesLayer.js";
import { VolumeProfileLayer }    from "./layers/VolumeProfileLayer.js";
import { SMCLayer }              from "./layers/SMCLayer.js";
import { OverlayLayer }          from "./layers/OverlayLayer.js";
import { DrawingLayer }          from "./layers/DrawingLayer.js";
import { PositionsLayer }        from "./layers/PositionsLayer.js";
import { MarkersLayer }          from "./layers/MarkersLayer.js";
import { SpreadLayer }           from "./layers/SpreadLayer.js";
import { MACDLayer }             from "./layers/MACDLayer.js";
import { RSILayer }              from "./layers/RSILayer.js";
import { CrosshairLayer }        from "./layers/CrosshairLayer.js";
import { HUDLayer }              from "./layers/HUDLayer.js";
import { AxisLayer }             from "./layers/AxisLayer.js";
import { PnLLayer }              from "./layers/PnLLayer.js";
import { SignalsLayer }          from "./layers/SignalsLayer.js";

export class Renderer {
  constructor(ctx, state, legendEl) {
    this.ctx = ctx;
    this.state = state;
    this.legendEl = legendEl;

    this.layers = [
      new GridLayer(),
      new DecisionLaneLayer(),
      new CandlesLayer(),
      new VolumeProfileLayer(),   // needs _priceScale (set by CandlesLayer)
      new SMCLayer(),             // SMC: FVG / OB / BOS
      new OverlayLayer(),         // BB + VWAP
      new DrawingLayer(),         // user trendlines / hlines
      new PnLLayer(),
      new SignalsLayer(),       // computed signal arrows + stop/target lines
      new PositionsLayer(),
      new MarkersLayer(),
      new SpreadLayer(),
      new MACDLayer(),
      new RSILayer(),
      new AxisLayer(),
      new CrosshairLayer(),
      new HUDLayer(this.legendEl),
    ];

    // RiskCalculator injected by Engine after construction
    this.riskCalc = null;
  }

  draw(scene) {
    const ctx = this.ctx;
    ctx.fillStyle = "#131722";
    ctx.fillRect(0, 0, scene.W, scene.H);

    for (const layer of this.layers) layer.draw(ctx, scene);

    // Risk calculator draws on top of everything except HUD/crosshair
    if (this.riskCalc && scene.state?.riskMode) {
      this.riskCalc.draw(ctx, scene);
    }

    this.state._scene = scene;
    this.state._panes = scene.panes;
    if (scene._priceScale) this.state._priceScale = scene._priceScale;
  }
}
