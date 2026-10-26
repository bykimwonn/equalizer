/**
 * DspChain — the complete real-time processing graph.
 *
 * Signal flow:
 *   input gain (smoothed) → parametric EQ → bass → clarity →
 *   dynamics (1-band or 2-band multiband) → stereo → loudness trim →
 *   output gain (smoothed) → limiter (ceiling) → out
 *
 * All scalar gains are smoothed per-sample to prevent clicks. Filter
 * coefficients update at block boundaries only when parameters change.
 */
import { ParametricEq, defaultBand, GRAPHIC_FREQS, normalizeBand } from './eq.js';
import { BassEnhancer } from './bass.js';
import { ClarityEnhancer } from './clarity.js';
import { Compressor } from './compressor.js';
import { Limiter } from './limiter.js';
import { StereoProcessor } from './stereo.js';
import { ParamSmoother, dbToGain } from './smooth.js';
import { designBiquad, createBiquadState, processBlockInPlace } from './biquad.js';

/** Full settings schema (version 1). Every module reads from this. */
export function defaultSettings() {
  return {
    version: 1,
    bypass: false,
    inputGainDb: 0,
    outputGainDb: 0,
    eq: {
      enabled: true,
      bands: GRAPHIC_FREQS.map((f, i) => defaultBand(i, f))
    },
    bass: {
      enabled: true,
      gainDb: 0,
      subGainDb: 0,
      harmonics: 0.3,
      protection: true
    },
    clarity: {
      enabled: true,
      presenceDb: 0,
      airDb: 0,
      transients: 0.3
    },
    compressor: {
      enabled: false,
      thresholdDb: -18,
      ratio: 3,
      attackMs: 10,
      releaseMs: 120,
      kneeDb: 6,
      makeupDb: 0,
      linked: true,
      multiband: false,
      crossoverHz: 250
    },
    limiter: {
      enabled: true,
      ceilingDb: -1,
      releaseMs: 80
    },
    stereo: {
      width: 1,
      balance: 0,
      mono: false
    },
    loudness: {
      normalization: false,
      targetLufs: -14,
      maxGainDb: 6
    }
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class DspChain {
  constructor(sampleRate = 48000, settings = defaultSettings()) {
    this.sampleRate = sampleRate;
    this.settings = defaultSettings();
    // modules
    this.eq = new ParametricEq(sampleRate, this.settings.eq.bands);
    this.bass = new BassEnhancer(sampleRate, this.settings.bass);
    this.clarity = new ClarityEnhancer(sampleRate, this.settings.clarity);
    this.comp = new Compressor(sampleRate, this.settings.compressor);
    this.compLow = new Compressor(sampleRate, this.settings.compressor);
    this.limiter = new Limiter(sampleRate, this.settings.limiter);
    this.stereo = new StereoProcessor(this.settings.stereo);
    // smoothers
    this._inGain = new ParamSmoother(sampleRate, 20, 1);
    this._outGain = new ParamSmoother(sampleRate, 20, 1);
    this._loudGain = new ParamSmoother(sampleRate, 1500, 1);
    this._loudnessEstimate = null;
    // multiband crossover (LR4: two cascaded Butterworth 2nd order)
    this._xoverLp = [createBiquadState(), createBiquadState()];
    this._xoverHp = [createBiquadState(), createBiquadState()];
    this._lowBufL = new Float32Array(4096);
    this._lowBufR = new Float32Array(4096);
    this._highBufL = new Float32Array(4096);
    this._highBufR = new Float32Array(4096);
    this.setSettings(settings);
    this.setSampleRate(sampleRate);
    // stats
    this.lastLimiterClamps = 0;
    this.lastGainReductionDb = 0;
    this.processSeconds = 0;
  }

  setSampleRate(sampleRate) {
    if (!(sampleRate > 0)) throw new RangeError('sampleRate must be > 0');
    this.sampleRate = sampleRate;
    this.eq.setSampleRate(sampleRate);
    this.bass.setSampleRate(sampleRate);
    this.clarity.setSampleRate(sampleRate);
    this.comp.setSampleRate(sampleRate);
    this.compLow.setSampleRate(sampleRate);
    this.limiter.setSampleRate(sampleRate);
    this._inGain.setSampleRate(sampleRate);
    this._outGain.setSampleRate(sampleRate);
    this._loudGain.setSampleRate(sampleRate);
    this._rebuildCrossover();
    return this;
  }

  _rebuildCrossover() {
    const f = clamp(Number(this.settings.compressor.crossoverHz) || 250, 40, 2000);
    this._xoverLpC = designBiquad('lowpass', f, 0.707, 0, this.sampleRate);
    this._xoverHpC = designBiquad('highpass', f, 0.707, 0, this.sampleRate);
    for (const s of [...this._xoverLp, ...this._xoverHp]) {
      s.x1 = 0; s.x2 = 0; s.y1 = 0; s.y2 = 0;
    }
  }

  /**
   * Apply a settings object. Unknown keys ignored; malformed module params are
   * normalized with clamping (never throws on out-of-range numbers — the AI
   * validator is stricter and reports what it changed).
   */
  setSettings(settings) {
    const d = defaultSettings();
    const s = this.settings;
    const inS = settings && typeof settings === 'object' ? settings : {};

    s.version = 1;
    s.bypass = inS.bypass === true;
    s.inputGainDb = clamp(Number(inS.inputGainDb) || 0, -24, 24);
    s.outputGainDb = clamp(Number(inS.outputGainDb) || 0, -24, 24);

    // EQ
    const eqIn = inS.eq && typeof inS.eq === 'object' ? inS.eq : {};
    s.eq.enabled = eqIn.enabled !== false;
    if (Array.isArray(eqIn.bands) && eqIn.bands.length > 0) {
      try {
        s.eq.bands = eqIn.bands.map((b, i) => normalizeBand({ ...defaultBand(i), ...b }, i));
      } catch {
        // keep previous bands on malformed input
      }
    } else if (!s.eq.bands) {
      s.eq.bands = d.eq.bands;
    }
    this.eq.setBands(s.eq.bands);

    // Bass
    const bIn = inS.bass && typeof inS.bass === 'object' ? inS.bass : {};
    s.bass = {
      enabled: bIn.enabled !== false,
      gainDb: clamp(Number(bIn.gainDb) || 0, -12, 12),
      subGainDb: clamp(Number(bIn.subGainDb) || 0, -12, 12),
      harmonics: clamp(Number.isFinite(Number(bIn.harmonics)) ? Number(bIn.harmonics) : 0.3, 0, 1),
      protection: bIn.protection !== false
    };
    this.bass.setParams(s.bass);

    // Clarity
    const cIn = inS.clarity && typeof inS.clarity === 'object' ? inS.clarity : {};
    s.clarity = {
      enabled: cIn.enabled !== false,
      presenceDb: clamp(Number(cIn.presenceDb) || 0, -12, 12),
      airDb: clamp(Number(cIn.airDb) || 0, -12, 12),
      transients: clamp(Number.isFinite(Number(cIn.transients)) ? Number(cIn.transients) : 0.3, 0, 1)
    };
    this.clarity.setParams(s.clarity);

    // Compressor
    const pIn = inS.compressor && typeof inS.compressor === 'object' ? inS.compressor : {};
    s.compressor = {
      enabled: pIn.enabled === true,
      thresholdDb: clamp(Number.isFinite(Number(pIn.thresholdDb)) ? Number(pIn.thresholdDb) : -18, -60, 0),
      ratio: clamp(Number.isFinite(Number(pIn.ratio)) ? Number(pIn.ratio) : 3, 1, 20),
      attackMs: clamp(Number.isFinite(Number(pIn.attackMs)) ? Number(pIn.attackMs) : 10, 0.1, 200),
      releaseMs: clamp(Number.isFinite(Number(pIn.releaseMs)) ? Number(pIn.releaseMs) : 120, 5, 2000),
      kneeDb: clamp(Number.isFinite(Number(pIn.kneeDb)) ? Number(pIn.kneeDb) : 6, 0, 24),
      makeupDb: clamp(Number(Number(pIn.makeupDb)) || 0, -12, 24),
      linked: pIn.linked !== false,
      multiband: pIn.multiband === true,
      crossoverHz: clamp(Number(pIn.crossoverHz) || 250, 40, 2000)
    };
    this.comp.setParams(s.compressor);
    // low band runs 6 dB more sensitive threshold (gentle bass control)
    this.compLow.setParams({ ...s.compressor, thresholdDb: s.compressor.thresholdDb - 6 });

    // Limiter
    const lIn = inS.limiter && typeof inS.limiter === 'object' ? inS.limiter : {};
    try {
      this.limiter.setParams({
        ceilingDb: Number.isFinite(Number(lIn.ceilingDb)) ? Number(lIn.ceilingDb) : -1,
        releaseMs: Number.isFinite(Number(lIn.releaseMs)) ? Number(lIn.releaseMs) : 80,
        enabled: lIn.enabled !== false
      });
    } catch {
      this.limiter.setParams({ ceilingDb: -1, releaseMs: 80, enabled: true });
    }
    s.limiter = {
      enabled: this.limiter.enabled,
      ceilingDb: this.limiter.ceilingDb,
      releaseMs: this.limiter.releaseMs
    };

    // Stereo
    const stIn = inS.stereo && typeof inS.stereo === 'object' ? inS.stereo : {};
    s.stereo = {
      width: clamp(Number.isFinite(Number(stIn.width)) ? Number(stIn.width) : 1, 0, 2),
      balance: clamp(Number(Number(stIn.balance)) || 0, -1, 1),
      mono: stIn.mono === true
    };
    this.stereo.setParams(s.stereo);

    // Loudness
    const loIn = inS.loudness && typeof inS.loudness === 'object' ? inS.loudness : {};
    s.loudness = {
      normalization: loIn.normalization === true,
      targetLufs: clamp(Number(loIn.targetLufs) || -14, -31, -5),
      maxGainDb: clamp(Number(loIn.maxGainDb) || 6, 0, 12)
    };

    this._inGain.setTarget(dbToGain(s.inputGainDb));
    this._outGain.setTarget(dbToGain(s.outputGainDb));
    if (s.compressor.multiband) this._rebuildCrossover();
  }

  getSettings() {
    return JSON.parse(JSON.stringify(this.settings));
  }

  /** Feed a loudness estimate (LUFS-ish) from the analyzer. */
  setLoudnessEstimate(lufs) {
    if (Number.isFinite(lufs)) this._loudnessEstimate = lufs;
  }

  /**
   * Process one stereo block in-place.
   * @param {Float32Array} L
   * @param {Float32Array} R
   * @returns {{clamps:number, gainReductionDb:number}}
   */
  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const s = this.settings;
    const t0 = performance.now();

    if (s.bypass) {
      // true bypass: samples untouched
      this.processSeconds += (performance.now() - t0) / 1000;
      return { clamps: 0, gainReductionDb: 0 };
    }

    const end = offset + len;

    // 1. input gain (smoothed per sample)
    {
      const g = this._inGain;
      for (let i = offset; i < end; i++) {
        const v = g.next();
        L[i] *= v;
        if (R !== L) R[i] *= v;
      }
    }

    // 2. EQ
    if (s.eq.enabled) this.eq.processStereo(L, R, offset, len);

    // 3. bass + clarity
    this.bass.processBlock(L, R, offset, len);
    this.clarity.processBlock(L, R, offset, len);

    // 4. dynamics
    let gr = 0;
    if (s.compressor.enabled) {
      if (s.compressor.multiband) {
        // ensure scratch buffers
        if (this._lowBufL.length < len) {
          this._lowBufL = new Float32Array(len);
          this._lowBufR = new Float32Array(len);
          this._highBufL = new Float32Array(len);
          this._highBufR = new Float32Array(len);
        }
        // split (LR4 = two cascaded 2nd-order)
        for (let i = offset; i < end; i++) {
          this._lowBufL[i - offset] = L[i];
          this._lowBufR[i - offset] = R === L ? L[i] : R[i];
        }
        this._highBufL.set(this._lowBufL.subarray(0, len));
        this._highBufR.set(this._lowBufR.subarray(0, len));
        for (const sLp of this._xoverLp) {
          processBlockInPlace(this._xoverLpC, sLp, this._lowBufL, 0, len);
          processBlockInPlace(this._xoverLpC, sLp, this._lowBufR, 0, len);
        }
        for (const sHp of this._xoverHp) {
          processBlockInPlace(this._xoverHpC, sHp, this._highBufL, 0, len);
          processBlockInPlace(this._xoverHpC, sHp, this._highBufR, 0, len);
        }
        const grLow = this.compLow.processBlock(this._lowBufL, this._lowBufR, 0, len);
        const grHigh = this.comp.processBlock(this._highBufL, this._highBufR, 0, len);
        gr = Math.max(grLow, grHigh);
        for (let i = offset; i < end; i++) {
          L[i] = this._lowBufL[i - offset] + this._highBufL[i - offset];
          if (R !== L) R[i] = this._lowBufR[i - offset] + this._highBufR[i - offset];
        }
      } else {
        gr = this.comp.processBlock(L, R, offset, len);
      }
    }
    this.lastGainReductionDb = gr;

    // 5. stereo image
    this.stereo.processBlock(L, R, offset, len);

    // 6. loudness trim (slow, bounded)
    if (s.loudness.normalization && this._loudnessEstimate !== null) {
      const err = s.loudness.targetLufs - this._loudnessEstimate; // dB
      const maxG = s.loudness.maxGainDb;
      this._loudGain.setTarget(dbToGain(clamp(err, -maxG, maxG)));
    } else {
      this._loudGain.setTarget(1);
    }
    {
      const g = this._loudGain;
      for (let i = offset; i < end; i++) {
        const v = g.next();
        L[i] *= v;
        if (R !== L) R[i] *= v;
      }
    }

    // 7. output gain (smoothed)
    {
      const g = this._outGain;
      for (let i = offset; i < end; i++) {
        const v = g.next();
        L[i] *= v;
        if (R !== L) R[i] *= v;
      }
    }

    // 8. limiter + final protection
    const lim = this.limiter.processBlock(L, R, offset, len);
    this.lastLimiterClamps += lim.clamps;

    this.processSeconds += (performance.now() - t0) / 1000;
    return { clamps: lim.clamps, gainReductionDb: Math.max(gr, lim.maxGainReductionDb) };
  }

  /** Composite EQ response in dB at arbitrary frequencies (for UI curve). */
  responseDb(freqs) {
    return this.eq.responseDb(freqs);
  }

  resetStates() {
    this.eq.clearStates();
    this.bass.reset();
    this.clarity.reset();
    this.comp.reset();
    this.compLow.reset();
    this.limiter.reset();
    this._inGain.snap(this._inGain.target);
    this._outGain.snap(this._outGain.target);
  }
}
