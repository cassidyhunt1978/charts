import { clamp } from "../util/math.js";

function lastBuyBeforeIndex(state, maxT){
  const buys = state.markers.filter(m => m.kind === "buy" && m.t <= maxT);
  if (!buys.length) return null;
  buys.sort((a,b)=>a.t-b.t);
  return buys[buys.length-1];
}
function hasSellAfter(state, buyT, maxT){
  return state.markers.some(m => m.kind === "sell" && m.t > buyT && m.t <= maxT);
}

export class ReplayController {
  constructor(state, onRender, setStatus) {
    this.state = state;
    this.onRender = onRender;
    this.setStatus = setStatus;
  }

  toggle() {
    this.state.replay.enabled = !this.state.replay.enabled;

    if (this.state.replay.enabled) {
      this.state.replay.index = Math.floor(this.state.bars.length * 0.65);
      this.state.replay.playing = false;
      this.state.replay.lastTick = 0;
      this.setStatus(`Replay ON @ index ${this.state.replay.index} (LabelLock ${this.state.replay.labelLock?"ON":"OFF"})`);
    } else {
      this.state.replay.index = null;
      this.state.replay.playing = false;
      this.setStatus("Replay OFF");
    }
    this.onRender();
  }

  toggleLabelLock(){
    this.state.replay.labelLock = !this.state.replay.labelLock;
    this.setStatus(`Replay LabelLock ${this.state.replay.labelLock?"ON":"OFF"}`);
    this.onRender();
  }

  _canStepForward(){
    if (!this.state.replay.enabled || !this.state.replay.labelLock) return true;
    if (this.state.replay.index == null) return true;
    if (!this.state.bars.length) return true;

    const maxT = this.state.bars[Math.min(this.state.replay.index, this.state.bars.length-1)].t;
    const buy = lastBuyBeforeIndex(this.state, maxT);
    if (!buy) return true;

    // If there is a buy but no sell after it (within current replay window), block.
    return hasSellAfter(this.state, buy.t, maxT);
  }

  step(dir) {
    if (!this.state.replay.enabled || this.state.replay.index == null) return;
    if (dir > 0 && !this._canStepForward()) {
      this.setStatus("LabelLock: add a SELL marker after the last BUY before stepping forward.");
      this.state.replay.playing = false;
      return;
    }
    const n = this.state.bars.length;
    this.state.replay.index = clamp(this.state.replay.index + dir, 0, n - 1);
    this.setStatus(`Replay index: ${this.state.replay.index}`);
    this.onRender();
  }

  togglePlay() {
    if (!this.state.replay.enabled) return;
    if (this.state.replay.playing) {
      this.state.replay.playing = false;
      this.setStatus("Replay PAUSE");
      return;
    }
    if (!this._canStepForward()) {
      this.setStatus("LabelLock: add a SELL marker after the last BUY before playing.");
      return;
    }
    this.state.replay.playing = true;
    this.state.replay.lastTick = 0;
    this.setStatus("Replay PLAY");
  }

  tick(ts) {
    if (!this.state.replay.enabled || !this.state.replay.playing) return;
    if (this.state.replay.index == null) return;

    if (!this._canStepForward()) {
      this.state.replay.playing = false;
      this.setStatus("LabelLock tripped: add SELL marker to continue.");
      return;
    }

    const last = this.state.replay.lastTick || ts;
    const dt = ts - last;
    if (dt < this.state.replay.playMs) return;

    this.state.replay.lastTick = ts;
    this.step(+1);
  }
}
