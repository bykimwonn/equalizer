import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParametricEq, normalizeBand, defaultBand, GRAPHIC_FREQS } from '../engine/dsp/eq.js';

function sine(freq, sr, n, amp = 0.5) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return b;
}

function rms(buf, from = 0.2) {
  const start = Math.floor(buf.length * from);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (buf.length - start));
}

test('EQ +6 dB at 1 kHz raises a 1 kHz tone by 6 dB and leaves 100 Hz alone', () => {
  const sr = 48000;
  const bands = GRAPHIC_FREQS.map((f, i) =>
    i === 6 ? { ...defaultBand(i, f), freq: 1000, gainDb: 6, q: 1.2 } : defaultBand(i, f)
  );
  const eq = new ParametricEq(sr, bands);
  const n = sr;

  const tone1k = sine(1000, sr, n);
  const ref1k = rms(tone1k);
  eq.processChannel(0, tone1k);
  const out1k = rms(tone1k);
  assert.ok(Math.abs(20 * Math.log10(out1k / ref1k) - 6) < 0.4, `1 kHz gain off`);

  const tone100 = sine(100, sr, n);
  const ref100 = rms(tone100);
  eq.processChannel(0, tone100);
  const out100 = rms(tone100);
  assert.ok(Math.abs(20 * Math.log10(out100 / ref100)) < 0.3, `100 Hz should be flat`);
});

test('responseDb composes multiple bands', () => {
  const sr = 48000;
  const bands = [
    { ...defaultBand(0, 60), gainDb: 4, q: 0.8 },
    { ...defaultBand(1, 6000), gainDb: -4, q: 1.0, type: 'highshelf' }
  ];
  const eq = new ParametricEq(sr, bands);
  const [low, mid, high] = eq.responseDb([60, 1000, 12000]);
  assert.ok(low > 2.5 && low < 5, `low band boost, got ${low}`);
  assert.ok(Math.abs(mid) < 1.5, `mid should be near flat, got ${mid}`);
  assert.ok(high < -2.5, `high shelf cut, got ${high}`);
});

test('sample-rate change keeps filter response consistent', () => {
  const bands = [{ ...defaultBand(0, 1000), gainDb: 6, q: 1 }];
  const eq44 = new ParametricEq(44100, bands);
  const eq48 = new ParametricEq(48000, bands);
  const d44 = eq44.responseDb([1000])[0];
  const d48 = eq48.responseDb([1000])[0];
  assert.ok(Math.abs(d44 - d48) < 0.1, `44.1k=${d44} vs 48k=${d48}`);

  // live reconfigure
  eq48.setSampleRate(44100);
  assert.ok(Math.abs(eq48.responseDb([1000])[0] - d44) < 0.1);
});

test('normalizeBand rejects invalid values and clamps none (throws)', () => {
  assert.throws(() => normalizeBand({ ...defaultBand(0), freq: 0 }), RangeError);
  assert.throws(() => normalizeBand({ ...defaultBand(0), freq: 50000 }), RangeError);
  assert.throws(() => normalizeBand({ ...defaultBand(0), gainDb: 40 }), RangeError);
  assert.throws(() => normalizeBand({ ...defaultBand(0), q: 0 }), RangeError);
  assert.throws(() => normalizeBand({ ...defaultBand(0), type: 'hack' }), RangeError);
  const ok = normalizeBand({ ...defaultBand(0), gainDb: -3.5 });
  assert.equal(ok.gainDb, -3.5);
});

test('disabled bands and 0 dB bands are true bypass within the EQ', () => {
  const sr = 48000;
  const bands = [
    { ...defaultBand(0, 60), gainDb: 10, enabled: false },
    { ...defaultBand(1, 1000), gainDb: 0 }
  ];
  const eq = new ParametricEq(sr, bands);
  const input = sine(60, sr, 48000);
  const ref = Float32Array.from(input);
  eq.processChannel(0, input);
  for (let i = 2000; i < input.length; i += 1000) {
    assert.ok(Math.abs(input[i] - ref[i]) < 1e-6);
  }
});

test('stereo channels are independent', () => {
  const sr = 48000;
  const bands = [{ ...defaultBand(0, 1000), gainDb: 6, q: 1 }];
  const eq = new ParametricEq(sr, bands);
  const L = sine(1000, sr, 24000);
  const R = sine(1000, sr, 24000, 0.25);
  const refR = rms(R);
  eq.processStereo(L, R);
  // both channels get the same filter shape → ratio preserved
  const outR = rms(R);
  assert.ok(Math.abs(20 * Math.log10(outR / refR) - 6) < 0.5);
});

test('setBand updates response immediately', () => {
  const sr = 48000;
  const eq = new ParametricEq(sr, [defaultBand(0, 1000)]);
  const before = eq.responseDb([1000])[0];
  eq.setBand(0, { gainDb: 6, freq: 1000, q: 1 });
  const after = eq.responseDb([1000])[0];
  assert.ok(Math.abs(before) < 1e-6);
  assert.ok(Math.abs(after - 6) < 0.05);
});
