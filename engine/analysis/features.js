/**
 * Real-time audio feature extraction from actual processed samples.
 *
 * Features (compact, non-sensitive summaries suitable for AI handoff):
 *  - rmsDb, peakDb, crestDb
 *  - bandEnergiesDb (8 bands, Hz ranges)
 *  - spectralCentroidHz, rolloff85Hz, spectralFlux
 *  - loudnessLufs (BS.1770-style K-weighted mean square estimate)
 *  - clipping count, dcOffset
 */
import { FFT, hannWindow, magnitudeSpectrum } from './fft.js';
import { designBiquad, createBiquadState, processSample } from '../dsp/biquad.js';

export const BAND_RANGES = Object.freeze([
  [20, 60],
  [60, 120],
  [120, 250],
  [250, 500],
  [500, 1000],
  [1000, 3000],
  [3000, 8000],
  [8000, 20000]
]);

export const FFT_SIZE = 2048;

export class FeatureExtractor {
  constructor(sampleRate = 48000, { fftSize = FFT_SIZE } = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.fft = new FFT(fftSize);
    this.window = hannWindow(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.mag = new Float32Array(fftSize / 2 + 1);
    this.prevMag = new Float32Array(fftSize / 2 + 1);
    this.inputScratch = new Float32Array(fftSize);
    this.writePos = 0;
    // K-weighting (BS.1770-ish): stage 1 high shelf + stage 2 high-pass @ 38 Hz
    this._kShelf = designBiquad('highshelf', 1681.97, 0.7071752, 3.99984, sampleRate);
    this._kHp = designBiquad('highpass', 38.13547, 0.500327, 0, sampleRate);
    this._kState = [
      [createBiquadState(), createBiquadState()],
      [createBiquadState(), createBiquadState()]
    ];
    this._meanSquare = 0;
    this._msAccum = 0;
    this._msCount = 0;
    this._frameCount = 0;
    this._clipCount = 0;
    this._dcAccum = 0;
    this._dcCount = 0;
    this._peakLinear = 0; // decaying peak held in the LINEAR domain

    this.latest = this._emptyFeatures();
    // precompute bin→band map
    this._bandBins = BAND_RANGES.map(([lo, hi]) => {
      const binLo = Math.max(0, Math.floor((lo / sampleRate) * fftSize));
      const binHi = Math.min(fftSize / 2, Math.ceil((hi / sampleRate) * fftSize));
      return [binLo, Math.max(binLo + 1, binHi)];
    });
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this._kShelf = designBiquad('highshelf', 1681.97, 0.7071752, 3.99984, sampleRate);
    this._kHp = designBiquad('highpass', 38.13547, 0.500327, 0, sampleRate);
    this._kState = [
      [createBiquadState(), createBiquadState()],
      [createBiquadState(), createBiquadState()]
    ];
    this._bandBins = BAND_RANGES.map(([lo, hi]) => {
      const binLo = Math.max(0, Math.floor((lo / sampleRate) * this.fftSize));
      const binHi = Math.min(this.fftSize / 2, Math.ceil((hi / sampleRate) * this.fftSize));
      return [binLo, Math.max(binLo + 1, binHi)];
    });
  }

  _emptyFeatures() {
    return {
      frameCount: 0,
      rmsDb: -160,
      peakDb: -160,
      crestDb: 0,
      bandEnergiesDb: BAND_RANGES.map(() => -160),
      spectralCentroidHz: 0,
      rolloff85Hz: 0,
      spectralFlux: 0,
      loudnessLufs: -70,
      clipCount: 0,
      dcOffset: 0
    };
  }

  /**
   * Feed a block of stereo samples (post/pre-chain). Returns true when a new
   * analysis frame was computed (≈ every fftSize/2 samples).
   * @param {Float32Array} L
   * @param {Float32Array} R
   * @param {number} offset
   * @param {number} len
   */
  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const end = offset + len;
    let peak = 0;
    let sumSq = 0;
    for (let i = offset; i < end; i++) {
      const l = L[i];
      const r = R === L ? l : R[i];
      const mono = 0.5 * (l + r);
      const abs = Math.max(Math.abs(l), Math.abs(r));
      if (abs > peak) peak = abs;
      sumSq += mono * mono;
      if (Math.abs(l) > 0.999 || Math.abs(r) > 0.999) this._clipCount++;
      this._dcAccum += mono;
      this._dcCount++;

      // K-weighted for loudness
      let k = processSample(this._kShelf, this._kState[0][0], mono);
      k = processSample(this._kHp, this._kState[0][1], k);
      this._msAccum += k * k;

      // ring buffer for FFT frames
      this.inputScratch[this.writePos] = mono;
      this.writePos++;
      if (this.writePos === this.fftSize) {
        this._computeFrame(peak);
        // 50% overlap
        this.inputScratch.copyWithin(0, this.fftSize / 2, this.fftSize);
        this.writePos = this.fftSize / 2;
      }
    }

    const rms = Math.sqrt(sumSq / Math.max(1, len));
    if (rms > 1e-8) {
      const rmsDb = 20 * Math.log10(rms);
      this.latest.rmsDb = this.latest.rmsDb < -150 ? rmsDb : 0.8 * this.latest.rmsDb + 0.2 * rmsDb;
    }
    // decay the held peak in the LINEAR domain (decaying negative dB would rise)
    this._peakLinear = Math.max(peak, this._peakLinear * 0.95);
    if (this._peakLinear > 1e-8) {
      this.latest.peakDb = 20 * Math.log10(this._peakLinear);
      this.latest.crestDb = this.latest.peakDb - this.latest.rmsDb;
    }
    this.latest.clipCount = this._clipCount;

    // running loudness (mean square window)
    this._msCount += len;
    if (this._msCount >= this.sampleRate / 4) {
      const ms = this._msAccum / Math.max(1, this._msCount * 2); // 2 ch worth accounted via mono
      const lufs = -0.691 + 10 * Math.log10(Math.max(1e-12, ms));
      this.latest.loudnessLufs = this.latest.loudnessLufs < -69 ? lufs : 0.7 * this.latest.loudnessLufs + 0.3 * lufs;
      this._msAccum = 0;
      this._msCount = 0;
      this.latest.dcOffset = this._dcAccum / Math.max(1, this._dcCount);
      this._dcAccum = 0;
      this._dcCount = 0;
    }

    return this.latest;
  }

  _computeFrame(peak) {
    const n = this.fftSize;
    magnitudeSpectrum(this.fft, this.re, this.im, this.mag, this.inputScratch, 0, this.window);
    const mag = this.mag;
    const bins = n / 2 + 1;
    const df = this.sampleRate / n;

    // band energies
    const bandEnergiesDb = this._bandBins.map(([lo, hi]) => {
      let e = 0;
      for (let k = lo; k < hi; k++) e += mag[k] * mag[k];
      return 10 * Math.log10(Math.max(1e-12, e));
    });

    // centroid & rolloff
    let num = 0;
    let den = 0;
    let total = 0;
    for (let k = 1; k < bins; k++) {
      const f = k * df;
      const m = mag[k];
      num += f * m;
      den += m;
      total += m;
    }
    const centroid = den > 1e-9 ? num / den : 0;
    let acc = 0;
    let rolloff = 0;
    const target = 0.85 * total;
    for (let k = 1; k < bins; k++) {
      acc += mag[k];
      if (acc >= target) {
        rolloff = k * df;
        break;
      }
    }

    // spectral flux (half-wave rectified bin-wise increase)
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      const d = mag[k] - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = mag[k];
    }

    const f = this.latest;
    f.frameCount = ++this._frameCount;
    f.bandEnergiesDb = bandEnergiesDb;
    f.spectralCentroidHz = f.spectralCentroidHz === 0 ? centroid : 0.7 * f.spectralCentroidHz + 0.3 * centroid;
    f.rolloff85Hz = rolloff;
    f.spectralFlux = 0.7 * f.spectralFlux + 0.3 * flux;
  }

  /** Magnitude spectrum snapshot (linear) for UI spectrum display. */
  spectrumSnapshot(outBands = 64) {
    const bins = this.fftSize / 2;
    const out = new Float32Array(outBands);
    const logMin = Math.log10(20);
    const logMax = Math.log10(this.sampleRate / 2);
    for (let i = 0; i < outBands; i++) {
      const f0 = Math.pow(10, logMin + ((logMax - logMin) * i) / outBands);
      const f1 = Math.pow(10, logMin + ((logMax - logMin) * (i + 1)) / outBands);
      const k0 = Math.max(1, Math.floor((f0 / this.sampleRate) * this.fftSize));
      const k1 = Math.max(k0 + 1, Math.min(bins, Math.ceil((f1 / this.sampleRate) * this.fftSize)));
      let m = 0;
      for (let k = k0; k < k1; k++) m = Math.max(m, this.mag[k]);
      out[i] = m;
    }
    return out;
  }

  reset() {
    this.writePos = 0;
    this._clipCount = 0;
    this.prevMag.fill(0);
    this.latest = this._emptyFeatures();
  }
}
