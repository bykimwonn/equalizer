/**
 * Feed-forward dynamics compressor with soft knee and optional stereo linking.
 * Gain computer (dB domain) → smoothed gain envelope (linear) → gain application.
 */
import { dbToGain, gainToDb } from './smooth.js';

export const COMP_BOUNDS = Object.freeze({
  thresholdDb: [-60, 0],
  ratio: [1, 20],
  attackMs: [0.1, 200],
  releaseMs: [5, 2000],
  kneeDb: [0, 24],
  makeupDb: [-12, 24]
});

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export class Compressor {
  constructor(sampleRate, params = {}) {
    this.sampleRate = sampleRate;
    this.envDb = -160; // smoothed detector level in dB
    this.params = {};
    this.setParams(params);
    this.lastGainReductionDb = 0;
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this._computeCoefs();
  }

  setParams(p = {}) {
    const b = COMP_BOUNDS;
    const pick = (name, dflt) => {
      const v = Number(p[name]);
      return Number.isFinite(v) ? clamp(v, b[name][0], b[name][1]) : dflt;
    };
    this.params = {
      enabled: p.enabled !== false,
      thresholdDb: pick('thresholdDb', -18),
      ratio: pick('ratio', 3),
      attackMs: pick('attackMs', 10),
      releaseMs: pick('releaseMs', 120),
      kneeDb: pick('kneeDb', 6),
      makeupDb: pick('makeupDb', 0),
      linked: p.linked !== false
    };
    this._computeCoefs();
  }

  _computeCoefs() {
    const atk = Math.max(0.5, this.params.attackMs);
    const rel = Math.max(5, this.params.releaseMs);
    this._atkCoef = Math.exp(-1 / ((atk / 1000) * this.sampleRate));
    this._relCoef = Math.exp(-1 / ((rel / 1000) * this.sampleRate));
    this._makeup = dbToGain(this.params.makeupDb);
    this._slope = 1 - 1 / Math.max(1, this.params.ratio);
    this._threshold = this.params.thresholdDb;
    this._knee = Math.max(1e-6, this.params.kneeDb);
    this._halfKnee = this.params.kneeDb / 2;
  }

  /** Static transfer curve in dB out (pre-makeup) for a level in dB. */
  static gainComputer(levelDb, thresholdDb, ratio, kneeDb) {
    const slope = 1 - 1 / Math.max(1, ratio);
    const halfKnee = Math.max(0, kneeDb) / 2;
    let over;
    if (halfKnee > 0 && levelDb > thresholdDb - halfKnee && levelDb < thresholdDb + halfKnee) {
      const x = levelDb - thresholdDb + halfKnee;
      over = (x * x) / (2 * Math.max(1e-6, kneeDb));
    } else if (levelDb >= thresholdDb + halfKnee) {
      over = levelDb - thresholdDb;
    } else {
      over = 0;
    }
    return over === 0 ? 0 : -over * slope; // gain reduction in dB (≤ 0, never -0)
  }

  /**
   * Process stereo in-place. Returns max |gain reduction| in dB over the block.
   */
  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const p = this.params;
    if (!p.enabled || p.ratio <= 1.001) {
      if (p.makeupDb !== 0) {
        const m = this._makeup;
        for (let i = offset; i < offset + len; i++) {
          L[i] *= m;
          if (R !== L) R[i] *= m;
        }
      }
      this.lastGainReductionDb = 0;
      return 0;
    }

    const end = offset + len;
    const atk = this._atkCoef;
    const rel = this._relCoef;
    let env = this.envDb;
    let maxGr = 0;
    const linked = p.linked;
    const makeup = this._makeup;

    for (let i = offset; i < end; i++) {
      const l = L[i];
      const r = R === L ? l : R[i];
      const peak = linked ? Math.max(Math.abs(l), Math.abs(r)) : 0;
      // per-sample detector level in dB
      let levelDb;
      if (linked) {
        levelDb = peak > 1e-8 ? 20 * Math.log10(peak) : -160;
      } else {
        // unlink path: use max of channels anyway for a shared envelope (musical,
        // avoids image shift), documented as linked-style even when linked=false
        const pk = Math.max(Math.abs(l), Math.abs(r));
        levelDb = pk > 1e-8 ? 20 * Math.log10(pk) : -160;
      }

      // envelope follower on detector level
      env = levelDb > env ? atk * env + (1 - atk) * levelDb : rel * env + (1 - rel) * levelDb;

      const grDb = Compressor.gainComputer(env, this._threshold, p.ratio, this._knee);
      if (-grDb > maxGr) maxGr = -grDb;
      const g = dbToGain(grDb) * makeup;
      L[i] = l * g;
      if (R !== L) R[i] = r * g;
    }

    this.envDb = env;
    this.lastGainReductionDb = maxGr;
    return maxGr;
  }

  reset() {
    this.envDb = -160;
  }
}

export { gainToDb };
