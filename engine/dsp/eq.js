/**
 * Multiband parametric equalizer built from stable RBJ biquads.
 * Bands are recomputed only when a parameter actually changes (block rate).
 */
import { designBiquad, createBiquadState, resetBiquadState, processBlockInPlace, magnitudeDbAt, isStable, FILTER_TYPES } from './biquad.js';

export const MIN_FREQ = 20;
export const MAX_FREQ = 20000;
export const MIN_GAIN_DB = -15;
export const MAX_GAIN_DB = 15;
export const MIN_Q = 0.1;
export const MAX_Q = 10;

/** Canonical 10-band graphic layout (Hz). */
export const GRAPHIC_FREQS = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

export function defaultBand(i, freq = GRAPHIC_FREQS[i] ?? 1000) {
  return {
    id: i,
    type: 'peaking',
    freq,
    gainDb: 0,
    q: 1.0,
    enabled: true
  };
}

/** Validate a single band; throws RangeError on invalid input. Returns a normalized copy. */
export function normalizeBand(band, i = 0) {
  if (!band || typeof band !== 'object') throw new RangeError('band must be an object');
  const type = String(band.type ?? 'peaking');
  if (!FILTER_TYPES.includes(type)) throw new RangeError(`invalid filter type: ${type}`);
  const freq = Number(band.freq);
  const gainDb = Number(band.gainDb);
  const q = Number(band.q);
  if (!Number.isFinite(freq) || freq < MIN_FREQ || freq > MAX_FREQ) {
    throw new RangeError(`freq must be in [${MIN_FREQ}, ${MAX_FREQ}], got ${band.freq}`);
  }
  if (!Number.isFinite(gainDb) || gainDb < MIN_GAIN_DB || gainDb > MAX_GAIN_DB) {
    throw new RangeError(`gainDb must be in [${MIN_GAIN_DB}, ${MAX_GAIN_DB}], got ${band.gainDb}`);
  }
  if (!Number.isFinite(q) || q < MIN_Q || q > MAX_Q) {
    throw new RangeError(`q must be in [${MIN_Q}, ${MAX_Q}], got ${band.q}`);
  }
  return {
    id: Number.isFinite(Number(band.id)) ? Number(band.id) : i,
    type,
    freq,
    gainDb,
    q,
    enabled: band.enabled !== false
  };
}

export class ParametricEq {
  /**
   * @param {number} sampleRate
   * @param {object[]} bands normalized band descriptors
   */
  constructor(sampleRate, bands = []) {
    this.sampleRate = sampleRate;
    this.bands = [];
    this._coeffs = [];
    this._states = [[], []]; // per channel, per band
    this.setBands(bands);
  }

  setSampleRate(sampleRate) {
    if (!(sampleRate > 0)) throw new RangeError('sampleRate must be > 0');
    this.sampleRate = sampleRate;
    this._rebuildAll();
  }

  setBands(bands) {
    this.bands = bands.map((b, i) => normalizeBand(b, i));
    this._rebuildAll();
  }

  setBand(index, patch) {
    if (index < 0 || index >= this.bands.length) throw new RangeError('band index out of range');
    this.bands[index] = normalizeBand({ ...this.bands[index], ...patch }, index);
    this._rebuildBand(index);
  }

  resetGains() {
    for (let i = 0; i < this.bands.length; i++) {
      this.bands[i] = { ...this.bands[i], gainDb: 0 };
      this._rebuildBand(i);
    }
  }

  clearStates() {
    for (const ch of this._states) for (const s of ch) resetBiquadState(s);
  }

  _rebuildAll() {
    this._coeffs = this.bands.map((b) => this._design(b));
    this._states = [0, 1].map(() => this.bands.map(() => createBiquadState()));
  }

  _rebuildBand(index) {
    this._coeffs[index] = this._design(this.bands[index]);
    this._states[0][index] = createBiquadState();
    this._states[1][index] = createBiquadState();
  }

  _design(b) {
    if (!b.enabled || Math.abs(b.gainDb) < 1e-9) {
      // neutral identity filter, still safe to run
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    }
    const c = designBiquad(b.type, b.freq, b.q, b.gainDb, this.sampleRate);
    if (!isStable(c)) throw new RangeError('designed filter is unstable');
    return c;
  }

  /**
   * Process one channel buffer in-place.
   * @param {number} channel 0|1
   * @param {Float32Array} buf
   */
  processChannel(channel, buf, offset = 0, len = buf.length - offset) {
    const coeffs = this._coeffs;
    const states = this._states[channel];
    for (let i = 0; i < coeffs.length; i++) {
      processBlockInPlace(coeffs[i], states[i], buf, offset, len);
    }
  }

  /** Convenience: process interleaved-free stereo pair in-place. */
  processStereo(L, R, offset = 0, len = L.length - offset) {
    this.processChannel(0, L, offset, len);
    this.processChannel(1, R, offset, len);
  }

  /** Composite magnitude response in dB at a set of frequencies. */
  responseDb(freqs) {
    return Array.from(freqs, (f) => {
      let db = 0;
      for (let i = 0; i < this.bands.length; i++) {
        const b = this.bands[i];
        if (!b.enabled || Math.abs(b.gainDb) < 1e-9) continue;
        db += magnitudeDbAt(this._coeffs[i], f, this.sampleRate);
      }
      return db;
    });
  }

  getBands() {
    return this.bands.map((b) => ({ ...b }));
  }
}
