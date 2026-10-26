import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  designBiquad,
  createBiquadState,
  processBlockInPlace,
  magnitudeAt,
  magnitudeDbAt,
  isStable,
  FILTER_TYPES
} from '../engine/dsp/biquad.js';

test('peaking filter gives exact gain at center frequency', () => {
  const sr = 48000;
  for (const gainDb of [-12, -6, -3, 3, 6, 12]) {
    const c = designBiquad('peaking', 1000, 1.0, gainDb, sr);
    assert.ok(isStable(c), `unstable for gain ${gainDb}`);
    const measured = magnitudeDbAt(c, 1000, sr);
    assert.ok(
      Math.abs(measured - gainDb) < 0.05,
      `expected ${gainDb} dB at 1 kHz, measured ${measured.toFixed(3)} dB`
    );
  }
});

test('peaking filter is flat far from center', () => {
  const sr = 48000;
  const c = designBiquad('peaking', 1000, 1.0, 6, sr);
  assert.ok(Math.abs(magnitudeDbAt(c, 50, sr)) < 0.2);
  assert.ok(Math.abs(magnitudeDbAt(c, 15000, sr)) < 0.2);
});

test('high shelf: -3dB corner behavior and flat extremes', () => {
  const sr = 48000;
  const c = designBiquad('highshelf', 4000, 0.707, 6, sr);
  assert.ok(isStable(c));
  assert.ok(Math.abs(magnitudeDbAt(c, 20, sr)) < 0.3, 'low freq untouched');
  const hi = magnitudeDbAt(c, 19000, sr);
  assert.ok(Math.abs(hi - 6) < 0.4, `high freq should approach +6 dB, got ${hi}`);
  const mid = magnitudeDbAt(c, 4000, sr);
  assert.ok(mid > 2 && mid < 5, `corner should be ~+3 dB, got ${mid}`);
});

test('low shelf shapes bass only', () => {
  const sr = 48000;
  const c = designBiquad('lowshelf', 120, 0.707, 6, sr);
  assert.ok(Math.abs(magnitudeDbAt(c, 20, sr) - 6) < 0.5);
  assert.ok(Math.abs(magnitudeDbAt(c, 12000, sr)) < 0.3);
});

test('highpass attenuates DC and passes treble', () => {
  const sr = 48000;
  const c = designBiquad('highpass', 100, 0.707, 0, sr);
  assert.ok(magnitudeDbAt(c, 10, sr) < -30);
  assert.ok(Math.abs(magnitudeDbAt(c, 10000, sr)) < 0.2);
});

test('all filter types produce stable coefficients in valid ranges', () => {
  const sr = 48000;
  for (const type of FILTER_TYPES) {
    for (const f of [30, 250, 1000, 8000, 18000]) {
      for (const q of [0.3, 0.707, 1, 4, 8]) {
        const c = designBiquad(type, f, q, 6, sr);
        assert.ok(isStable(c), `${type} f=${f} q=${q} unstable`);
      }
    }
  }
});

test('invalid parameters are rejected', () => {
  const sr = 48000;
  assert.throws(() => designBiquad('peaking', 0, 1, 3, sr), RangeError);
  assert.throws(() => designBiquad('peaking', 30000, 1, 3, sr), RangeError); // above nyquist
  assert.throws(() => designBiquad('peaking', 1000, 0, 3, sr), RangeError);
  assert.throws(() => designBiquad('peaking', 1000, -1, 3, sr), RangeError);
  assert.throws(() => designBiquad('peaking', 1000, 1, 999, sr), RangeError); // insane gain
  assert.throws(() => designBiquad('bogus', 1000, 1, 3, sr), RangeError);
  assert.throws(() => designBiquad('peaking', NaN, 1, 3, sr), RangeError);
  assert.throws(() => designBiquad('peaking', 1000, 1, Infinity, sr), RangeError);
  assert.throws(() => designBiquad('peaking', 1000, 1, 3, 0), RangeError);
});

test('time-domain processing matches analytic magnitude response', () => {
  const sr = 48000;
  const freq = 1000;
  const gainDb = 8;
  const c = designBiquad('peaking', freq, 2.0, gainDb, sr);
  const n = sr; // 1 second
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  const st = createBiquadState();
  processBlockInPlace(c, st, buf);
  // measure RMS over the steady part (skip transient)
  const start = Math.floor(n * 0.2);
  let sum = 0;
  for (let i = start; i < n; i++) sum += buf[i] * buf[i];
  const rmsOut = Math.sqrt(sum / (n - start));
  const rmsIn = Math.SQRT1_2;
  const measuredDb = 20 * Math.log10(rmsOut / rmsIn);
  assert.ok(
    Math.abs(measuredDb - gainDb) < 0.15,
    `time-domain gain ${measuredDb.toFixed(3)} dB != ${gainDb} dB`
  );
});

test('processing is bit-stable on random input (no NaN/Inf)', () => {
  const sr = 48000;
  const c = designBiquad('peaking', 250, 5, 12, sr);
  const st = createBiquadState();
  const buf = new Float32Array(4096);
  let seed = 42;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (seed / 0x3fffffff - 1) * 0.9;
  }
  processBlockInPlace(c, st, buf);
  for (const v of buf) assert.ok(Number.isFinite(v));
});

test('magnitudeAt equals direct complex evaluation', () => {
  const c = designBiquad('peaking', 440, 1.2, -4, 44100);
  // brute force with explicit complex math
  const f = 440;
  const w = (2 * Math.PI * f) / 44100;
  const z1 = { re: Math.cos(-w), im: Math.sin(-w) };
  const z2 = { re: Math.cos(-2 * w), im: Math.sin(-2 * w) };
  const n = {
    re: c.b0 + c.b1 * z1.re + c.b2 * z2.re,
    im: c.b1 * z1.im + c.b2 * z2.im
  };
  const d = {
    re: 1 + c.a1 * z1.re + c.a2 * z2.re,
    im: c.a1 * z1.im + c.a2 * z2.im
  };
  const expected = Math.hypot(n.re, n.im) / Math.hypot(d.re, d.im);
  assert.ok(Math.abs(magnitudeAt(c, f, 44100) - expected) < 1e-9);
});
