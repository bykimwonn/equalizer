/**
 * Clarity & detail enhancement.
 * - Presence peaking filter (vocal definition) and air high-shelf.
 * - Optional subtle transient emphasis based on a fast/slow envelope ratio.
 *   This is a dynamics-based perception effect — it does NOT "reconstruct"
 *   detail that is absent from the source.
 */
import { designBiquad, createBiquadState, processBlockInPlace } from './biquad.js';
import { dbToGain } from './smooth.js';

export class ClarityEnhancer {
  constructor(sampleRate, params = {}) {
    this.sampleRate = sampleRate;
    this.params = {};
    this._presL = createBiquadState();
    this._presR = createBiquadState();
    this._airL = createBiquadState();
    this._airR = createBiquadState();
    this._fastEnv = 0;
    this._slowEnv = 0;
    this.setParams(params);
    this.setSampleRate(sampleRate);
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this._rebuild();
  }

  setParams(p = {}) {
    const num = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    this.params = {
      enabled: p.enabled !== false,
      presenceDb: num(p.presenceDb, -12, 12, 0), // peaking @ 3 kHz
      airDb: num(p.airDb, -12, 12, 0), // high shelf @ 11 kHz
      transients: num(p.transients, 0, 1, 0) // 0..1 transient emphasis amount
    };
    this._rebuild();
  }

  _rebuild() {
    const sr = this.sampleRate;
    this._presC = designBiquad('peaking', 3000, 0.9, this.params.presenceDb, sr);
    this._airC = designBiquad('highshelf', 11000, 0.707, this.params.airDb, sr);
    // envelope coefficients: fast 1 ms, slow 60 ms
    this._fastCoef = Math.exp(-1 / (0.001 * sr));
    this._slowCoef = Math.exp(-1 / (0.06 * sr));
  }

  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const p = this.params;
    if (!p.enabled) return;

    if (Math.abs(p.presenceDb) > 1e-6) {
      processBlockInPlace(this._presC, this._presL, L, offset, len);
      if (R !== L) processBlockInPlace(this._presC, this._presR, R, offset, len);
    }
    if (Math.abs(p.airDb) > 1e-6) {
      processBlockInPlace(this._airC, this._airL, L, offset, len);
      if (R !== L) processBlockInPlace(this._airC, this._airR, R, offset, len);
    }

    if (p.transients > 1e-4) {
      const maxBoostDb = 3 * p.transients; // bounded, subtle
      const maxBoost = dbToGain(maxBoostDb);
      const fast = this._fastCoef;
      const slow = this._slowCoef;
      let fEnv = this._fastEnv;
      let sEnv = this._slowEnv;
      const end = offset + len;
      for (let i = offset; i < end; i++) {
        const peak = Math.max(Math.abs(L[i]), R === L ? 0 : Math.abs(R[i]));
        fEnv = peak > fEnv ? fast * fEnv + (1 - fast) * peak : fEnv * fast;
        sEnv = slow * sEnv + (1 - slow) * peak;
        let boost = 1;
        if (sEnv > 1e-6) {
          const ratio = fEnv / sEnv;
          if (ratio > 1.15) {
            // transient detected → bounded lift
            boost = 1 + Math.min(maxBoost - 1, (ratio - 1.15) * 0.25 * maxBoost);
          }
        }
        L[i] *= boost;
        if (R !== L) R[i] *= boost;
      }
      this._fastEnv = fEnv;
      this._slowEnv = sEnv;
    }
  }

  reset() {
    for (const s of [this._presL, this._presR, this._airL, this._airR]) {
      s.x1 = 0; s.x2 = 0; s.y1 = 0; s.y2 = 0;
    }
    this._fastEnv = 0;
    this._slowEnv = 0;
  }
}
