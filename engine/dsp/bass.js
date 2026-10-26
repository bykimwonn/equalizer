/**
 * Dynamic bass enhancement.
 * - Low-shelf tone shaping (bass / sub bands)
 * - Optional harmonic enhancement: low band → gentle waveshaping → band-limited
 *   harmonics mixed back in. Enhances *perception* of bass without huge LF energy.
 * - Bass clipping protection: soft saturation on the bass path + final hard limits
 *   are handled by the output limiter; this module never exceeds its internal cap.
 */
import { designBiquad, createBiquadState, processSample, processBlockInPlace } from './biquad.js';
import { dbToGain } from './smooth.js';

export class BassEnhancer {
  constructor(sampleRate, params = {}) {
    this.sampleRate = sampleRate;
    this.params = {};
    // harmonic path states (per channel)
    this._harmLp = [createBiquadState(), createBiquadState()];
    this._harmHp = [createBiquadState(), createBiquadState()];
    this._harmOutLp = [createBiquadState(), createBiquadState()];
    this._shelfL = createBiquadState();
    this._shelfR = createBiquadState();
    this._subL = createBiquadState();
    this._subR = createBiquadState();
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
      gainDb: num(p.gainDb, -12, 12, 0), // main bass shelf @120 Hz
      subGainDb: num(p.subGainDb, -12, 12, 0), // sub shelf @45 Hz
      harmonics: num(p.harmonics, 0, 1, 0), // 0..1 amount of harmonic enhancement
      protection: p.protection !== false
    };
    this._rebuild();
  }

  _rebuild() {
    const sr = this.sampleRate;
    this._shelf = designBiquad('lowshelf', 120, 0.707, this.params.gainDb, sr);
    this._sub = designBiquad('lowshelf', 45, 0.707, this.params.subGainDb, sr);
    this._harmLpC = designBiquad('lowpass', 120, 0.707, 0, sr);
    this._harmHpC = designBiquad('highpass', 35, 0.707, 0, sr);
    this._harmOutLpC = designBiquad('lowpass', 180, 0.707, 0, sr);
    this._harmDrive = 1 + 4 * this.params.harmonics;
  }

  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const p = this.params;
    if (!p.enabled) return;

    // Tone shaping always runs when enabled (even at 0 dB — shelves become identity-ish)
    if (Math.abs(p.gainDb) > 1e-6) {
      processBlockInPlace(this._shelf, this._shelfL, L, offset, len);
      if (R !== L) processBlockInPlace(this._shelf, this._shelfR, R, offset, len);
    }
    if (Math.abs(p.subGainDb) > 1e-6) {
      processBlockInPlace(this._sub, this._subL, L, offset, len);
      if (R !== L) processBlockInPlace(this._sub, this._subR, R, offset, len);
    }

    if (p.harmonics > 1e-4) {
      const amount = 0.35 * p.harmonics;
      const drive = this._harmDrive;
      const end = offset + len;
      for (let ch = 0; ch < (R === L ? 1 : 2); ch++) {
        const buf = ch === 0 ? L : R;
        const st = ch === 0 ? 0 : 1;
        const sLp = this._harmLp[st];
        const sHp = this._harmHp[st];
        const sOut = this._harmOutLp[st];
        for (let i = offset; i < end; i++) {
          // band-limited low input
          let x = processSample(this._harmLpC, sLp, buf[i]);
          x = processSample(this._harmHpC, sHp, x);
          // waveshaping generates even/odd harmonics of the low band
          let h = Math.tanh(x * drive) - x * 0.5;
          if (p.protection) {
            // soft cap the generated component
            h = Math.tanh(h * 1.6) * 0.62;
          }
          h = processSample(this._harmOutLpC, sOut, h);
          buf[i] = buf[i] + amount * h;
        }
      }
    }
  }

  reset() {
    for (const s of [
      this._shelfL, this._shelfR, this._subL, this._subR,
      ...this._harmLp, ...this._harmHp, ...this._harmOutLp
    ]) {
      s.x1 = 0; s.x2 = 0; s.y1 = 0; s.y2 = 0;
    }
  }
}

export { dbToGain };
