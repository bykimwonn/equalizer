/**
 * EQ response curve math for the UI — computed from the SAME RBJ biquad
 * coefficients the DSP chain uses. Never a decorative approximation.
 */
import { designBiquad, magnitudeDbAt } from '../engine/dsp/biquad.js';

export const FREQ_MIN = 20;
export const FREQ_MAX = 20000;

export function logSpace(n, min = FREQ_MIN, max = FREQ_MAX) {
  const out = new Array(n);
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  for (let i = 0; i < n; i++) {
    out[i] = Math.pow(10, lmin + ((lmax - lmin) * i) / (n - 1));
  }
  return out;
}

export const freqToX = (f, width) =>
  (Math.log10(f / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN)) * width;

export const xToFreq = (x, width) =>
  Math.pow(10, Math.log10(FREQ_MIN) + (Math.log10(FREQ_MAX / FREQ_MIN) * x) / width);

/** Composite magnitude response of the current EQ bands in dB. */
export function eqResponseDb(bands, sampleRate = 48000, freqs = logSpace(160)) {
  return freqs.map((f) => {
    let db = 0;
    for (const b of bands) {
      if (!b.enabled || Math.abs(b.gainDb) < 1e-9) continue;
      try {
        const c = designBiquad(b.type, Math.min(f > 0 ? b.freq : 1000, sampleRate * 0.49), b.q, b.gainDb, sampleRate);
        db += magnitudeDbAt(c, f, sampleRate);
      } catch {
        // band with invalid freq for this rate — skip for the visual curve
      }
    }
    return db;
  });
}

/** Single-band response (for the selected band overlay). */
export function bandResponseDb(band, sampleRate = 48000, freqs = logSpace(160)) {
  if (!band || !band.enabled || Math.abs(band.gainDb) < 1e-9) return freqs.map(() => 0);
  return freqs.map((f) => {
    try {
      const c = designBiquad(band.type, band.freq, band.q, band.gainDb, sampleRate);
      return magnitudeDbAt(c, f, sampleRate);
    } catch {
      return 0;
    }
  });
}
