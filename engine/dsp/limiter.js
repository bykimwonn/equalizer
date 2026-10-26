/**
 * Peak limiter / output protection.
 * Envelope-based gain reduction toward a ceiling, plus a sample-accurate safety
 * clamp that is counted (never silent). Prevents clipping and harsh overruns.
 */
import { dbToGain } from './smooth.js';

export class Limiter {
  constructor(sampleRate, { ceilingDb = -1, releaseMs = 80, enabled = true } = {}) {
    this.sampleRate = sampleRate;
    this.gain = 1; // smoothed gain (≤ 1)
    this.clampCount = 0;
    this.lastGainReductionDb = 0;
    this.setParams({ ceilingDb, releaseMs, enabled });
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this._computeCoef();
  }

  setParams({ ceilingDb, releaseMs, enabled } = {}) {
    if (ceilingDb !== undefined) {
      const c = Number(ceilingDb);
      if (!Number.isFinite(c) || c > -0.1 || c < -24) {
        throw new RangeError(`ceilingDb must be in [-24, -0.1], got ${ceilingDb}`);
      }
      this.ceilingDb = c;
      this.ceiling = dbToGain(c);
    } else if (this.ceiling === undefined) {
      this.ceilingDb = -1;
      this.ceiling = dbToGain(-1);
    }
    if (releaseMs !== undefined) {
      const r = Number(releaseMs);
      if (!Number.isFinite(r) || r < 5 || r > 2000) {
        throw new RangeError(`releaseMs must be in [5, 2000], got ${releaseMs}`);
      }
      this.releaseMs = r;
    } else if (this.releaseMs === undefined) {
      this.releaseMs = 80;
    }
    if (enabled !== undefined) this.enabled = enabled !== false;
    else if (this.enabled === undefined) this.enabled = true;
    this._computeCoef();
  }

  _computeCoef() {
    // fast attack (≈1 ms) prevents overs; release restores level smoothly
    this._atkCoef = Math.exp(-1 / ((0.001) * this.sampleRate));
    this._relCoef = Math.exp(-1 / ((this.releaseMs / 1000) * this.sampleRate));
    if (this.ceiling === undefined) this.ceiling = dbToGain(-1);
    if (this.gain === undefined) this.gain = 1;
  }

  /**
   * Process stereo in-place. Returns stats { clamps, maxGainReductionDb }.
   */
  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const end = offset + len;
    const ceiling = this.ceiling;
    const enabled = this.enabled;
    let gain = this.gain;
    const atk = this._atkCoef;
    const rel = this._relCoef;
    let clamps = 0;
    let maxGr = 0;

    for (let i = offset; i < end; i++) {
      let l = L[i];
      let r = R === L ? l : R[i];
      const peak = Math.max(Math.abs(l), Math.abs(r));

      if (enabled) {
        const target = peak > ceiling ? ceiling / peak : 1;
        // approach lower gains quickly, release slowly
        gain = target < gain ? atk * gain + (1 - atk) * target : rel * gain + (1 - rel) * target;
        if (gain > 1) gain = 1;
        const grDb = gain < 1 ? -20 * Math.log10(Math.max(1e-8, gain)) : 0;
        if (grDb > maxGr) maxGr = grDb;
        l *= gain;
        r *= gain;
      }

      // sample-accurate safety clamp (counted, never hidden)
      if (l > ceiling) {
        l = ceiling;
        clamps++;
      } else if (l < -ceiling) {
        l = -ceiling;
        clamps++;
      }
      if (r > ceiling) {
        r = ceiling;
        clamps++;
      } else if (r < -ceiling) {
        r = -ceiling;
        clamps++;
      }

      L[i] = l;
      if (R !== L) R[i] = r;
    }

    this.gain = gain;
    this.clampCount += clamps;
    this.lastGainReductionDb = maxGr;
    return { clamps, maxGainReductionDb: maxGr };
  }

  reset() {
    this.gain = 1;
  }
}
