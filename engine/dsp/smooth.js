/**
 * Parameter smoothing utilities.
 * Audio-thread friendly: fixed state, no allocation per sample.
 */

/**
 * One-pole exponential smoother toward a target value.
 * tauMs: time constant (ms) — larger = slower.
 */
export class ParamSmoother {
  constructor(sampleRate, tauMs = 30, initial = 0) {
    this.sampleRate = sampleRate;
    this.tauMs = tauMs;
    this.value = initial;
    this.target = initial;
    this._coef = 0;
    this._recompute();
  }

  _recompute() {
    const tauSec = Math.max(1e-4, this.tauMs / 1000);
    this._coef = Math.exp(-1 / (tauSec * this.sampleRate));
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this._recompute();
  }

  setTauMs(tauMs) {
    this.tauMs = tauMs;
    this._recompute();
  }

  setTarget(t) {
    this.target = t;
  }

  snap(v) {
    this.value = v;
    this.target = v;
    return v;
  }

  /** Advance one sample, return smoothed value. */
  next() {
    const c = this._coef;
    this.value = this.target + (this.value - this.target) * c;
    return this.value;
  }

  /** Jump n samples ahead without per-sample work (used when value is close). */
  skip(n) {
    const c = Math.pow(this._coef, n);
    this.value = this.target + (this.value - this.target) * c;
    return this.value;
  }

  get settled() {
    return Math.abs(this.value - this.target) < 1e-6;
  }
}

/** dB → linear gain. */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** linear gain → dB (floor at -160 dB). */
export function gainToDb(g) {
  return 20 * Math.log10(Math.max(1e-8, g));
}
