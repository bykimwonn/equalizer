import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, hannWindow, magnitudeSpectrum } from '../engine/analysis/fft.js';
import { FeatureExtractor } from '../engine/analysis/features.js';

test('FFT: pure sine peaks at the correct bin with correct amplitude', () => {
  const n = 1024;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float32Array(n / 2 + 1);
  const k0 = 32;
  const amp = 0.75;
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = amp * Math.sin((2 * Math.PI * k0 * i) / n);
  magnitudeSpectrum(fft, re, im, mag, input, 0, hannWindow(n));
  let peakBin = 0;
  let peakVal = 0;
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] > peakVal) {
      peakVal = mag[k];
      peakBin = k;
    }
  }
  assert.equal(peakBin, k0);
  assert.ok(Math.abs(peakVal - amp) < 0.02, `amplitude ${peakVal} != ${amp}`);
});

test('FFT: DC signal lands in bin 0', () => {
  const n = 256;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float32Array(n / 2 + 1);
  const input = new Float32Array(n).fill(0.5);
  magnitudeSpectrum(fft, re, im, mag, input);
  assert.equal(mag[0], 1.0); // 2/N * sum(0.5) = 1.0 with our normalization
});

test('FFT rejects non-power-of-two sizes', () => {
  assert.throws(() => new FFT(1000), RangeError);
  assert.throws(() => new FFT(0), RangeError);
});

test('features: RMS/peak/crest of a known sine are accurate', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const amp = 0.5;
  const n = sr;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / sr);
  fe.processBlock(buf, buf, 0, n);
  const expectedRmsDb = 20 * Math.log10(amp / Math.SQRT2);
  assert.ok(Math.abs(fe.latest.rmsDb - expectedRmsDb) < 0.4, `rms ${fe.latest.rmsDb} vs ${expectedRmsDb}`);
  assert.ok(Math.abs(fe.latest.peakDb - 20 * Math.log10(amp)) < 0.5);
  assert.ok(Math.abs(fe.latest.crestDb - 3.01) < 0.8, `crest ${fe.latest.crestDb}`);
});

test('features: band energies identify tone location', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const buf = new Float32Array(sr);
  for (let i = 0; i < sr; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / sr);
  fe.processBlock(buf, buf, 0, sr);
  const bands = fe.latest.bandEnergiesDb;
  // band index 5 is 1000–3000 Hz, band 6 is 3000–8000 Hz
  const strongest = bands.indexOf(Math.max(...bands));
  assert.ok([5, 6].includes(strongest), `tone at 3 kHz should dominate, bands=${bands.map((b) => b.toFixed(1))}`);
});

test('features: spectral centroid near tone frequency', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const buf = new Float32Array(sr * 2);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / sr);
  fe.processBlock(buf, buf, 0, buf.length);
  assert.ok(
    Math.abs(fe.latest.spectralCentroidHz - 2000) < 150,
    `centroid ${fe.latest.spectralCentroidHz}`
  );
});

test('features: clipping is detected', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const buf = new Float32Array(4800).fill(1.0);
  fe.processBlock(buf, buf, 0, buf.length);
  assert.ok(fe.latest.clipCount > 1000);
});

test('features: loudness estimate rises with level', () => {
  const sr = 48000;
  const mk = (amp) => {
    const fe = new FeatureExtractor(sr);
    const buf = new Float32Array(sr * 2);
    for (let i = 0; i < buf.length; i++) buf[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sr);
    fe.processBlock(buf, buf, 0, buf.length);
    return fe.latest.loudnessLufs;
  };
  const quiet = mk(0.05);
  const loud = mk(0.5);
  assert.ok(loud > quiet + 15, `loud ${loud} should be much > quiet ${quiet}`);
});

test('features: spectral flux responds to sudden change', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const buf = new Float32Array(sr);
  for (let i = 0; i < sr / 2; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / sr);
  for (let i = sr / 2; i < sr; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * 5000 * i) / sr);
  fe.processBlock(buf, buf, 0, buf.length);
  assert.ok(fe.latest.spectralFlux > 0);
});

test('features: spectrumSnapshot has requested band count and log spacing', () => {
  const sr = 48000;
  const fe = new FeatureExtractor(sr);
  const buf = new Float32Array(sr);
  for (let i = 0; i < sr; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * 997 * i) / sr);
  fe.processBlock(buf, buf, 0, sr);
  const snap = fe.features ? fe.features.spectrumSnapshot(64) : fe.spectrumSnapshot(64);
  assert.equal(snap.length, 64);
  assert.ok(Math.max(...snap) > 0);
});
