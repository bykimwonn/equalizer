import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compressor } from '../engine/dsp/compressor.js';
import { Limiter } from '../engine/dsp/limiter.js';
import { ParamSmoother, dbToGain, gainToDb } from '../engine/dsp/smooth.js';

function sineBlocks(freq, sr, seconds, amp) {
  const n = Math.floor(sr * seconds);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return L;
}

function rmsFrom(buf, fromSec, sr) {
  const start = Math.floor(fromSec * sr);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (buf.length - start));
}

test('compressor steady-state gain matches transfer curve', () => {
  const sr = 48000;
  const peakDb = -20;
  const amp = dbToGain(peakDb);
  const comp = new Compressor(sr, {
    enabled: true,
    thresholdDb: -30,
    ratio: 4,
    attackMs: 1,
    releaseMs: 50,
    kneeDb: 0,
    makeupDb: 0
  });
  const buf = sineBlocks(200, sr, 2, amp);
  comp.processBlock(buf, buf, 0, buf.length);
  const outRms = rmsFrom(buf, 1.0, sr);
  const outPeakDb = gainToDb(outRms * Math.SQRT2);
  // expected: peak -20 → 10 dB over threshold → GR = 10*(1-1/4) = 7.5 dB → -27.5 dBFS peak
  assert.ok(
    Math.abs(outPeakDb - -27.5) < 0.6,
    `expected ~-27.5 dBFS peak, got ${outPeakDb.toFixed(2)}`
  );
});

test('compressor below threshold is transparent (with knee 0)', () => {
  const sr = 48000;
  const comp = new Compressor(sr, {
    enabled: true, thresholdDb: -30, ratio: 4, attackMs: 1, releaseMs: 50, kneeDb: 0
  });
  const amp = dbToGain(-40);
  const buf = sineBlocks(200, sr, 1, amp);
  const ref = rmsFrom(buf, 0.3, sr);
  comp.processBlock(buf, buf, 0, buf.length);
  const out = rmsFrom(buf, 0.3, sr);
  assert.ok(Math.abs(20 * Math.log10(out / ref)) < 0.3);
});

test('compressor ratio 1 is transparent even above threshold', () => {
  const sr = 48000;
  const comp = new Compressor(sr, { enabled: true, thresholdDb: -40, ratio: 1, kneeDb: 0 });
  const buf = sineBlocks(200, sr, 1, 0.5);
  const ref = rmsFrom(buf, 0.3, sr);
  comp.processBlock(buf, buf, 0, buf.length);
  const out = rmsFrom(buf, 0.3, sr);
  assert.ok(Math.abs(20 * Math.log10(out / ref)) < 0.2);
});

test('gain computer: soft knee is between hard-knee cases', () => {
  const th = -20;
  const ratio = 4;
  const atKnee = Compressor.gainComputer(th, th, ratio, 6);
  assert.ok(atKnee < -0.01 && atKnee > -2, `knee GR at threshold: ${atKnee}`);
  const above = Compressor.gainComputer(th + 10, th, ratio, 6);
  assert.ok(Math.abs(above - -7.5) < 0.01);
  const below = Compressor.gainComputer(th - 10, th, ratio, 6);
  assert.equal(below, 0);
});

test('makeup gain is applied exactly', () => {
  const sr = 48000;
  const comp = new Compressor(sr, {
    enabled: true, thresholdDb: -10, ratio: 2, kneeDb: 0, makeupDb: 4, attackMs: 1, releaseMs: 20
  });
  const buf = sineBlocks(200, sr, 1, 0.1); // below threshold
  const ref = rmsFrom(buf, 0.3, sr);
  comp.processBlock(buf, buf, 0, buf.length);
  const out = rmsFrom(buf, 0.3, sr);
  assert.ok(Math.abs(20 * Math.log10(out / ref) - 4) < 0.2);
});

test('invalid compressor params are clamped to bounds', () => {
  const c = new Compressor(48000, {
    thresholdDb: -200, ratio: 1000, attackMs: -5, releaseMs: 1e9, kneeDb: -4, makeupDb: 100
  });
  assert.equal(c.params.thresholdDb, -60);
  assert.equal(c.params.ratio, 20);
  assert.equal(c.params.attackMs, 0.1);
  assert.equal(c.params.releaseMs, 2000);
  assert.equal(c.params.kneeDb, 0);
  assert.equal(c.params.makeupDb, 24);
});

test('limiter never exceeds ceiling on huge input', () => {
  const sr = 48000;
  const lim = new Limiter(sr, { ceilingDb: -1, releaseMs: 80, enabled: true });
  const ceiling = dbToGain(-1);
  const buf = sineBlocks(150, sr, 2, 2.0); // +6 dBFS hot
  const res = lim.processBlock(buf, buf, 0, buf.length);
  let maxAbs = 0;
  for (const v of buf) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= ceiling + 1e-6, `peak ${maxAbs} above ceiling ${ceiling}`);
  assert.ok(res.clamps > 0, 'clamps must be counted, not hidden');
});

test('limiter is transparent below ceiling', () => {
  const sr = 48000;
  const lim = new Limiter(sr, { ceilingDb: -1, enabled: true });
  const buf = sineBlocks(100, sr, 1, 0.5);
  const ref = Float32Array.from(buf);
  lim.processBlock(buf, buf, 0, buf.length);
  for (let i = 1000; i < buf.length; i += 500) {
    assert.ok(Math.abs(buf[i] - ref[i]) < 0.02);
  }
});

test('limiter rejects out-of-bounds ceiling', () => {
  assert.throws(() => new Limiter(48000, { ceilingDb: 0 }), RangeError);
  assert.throws(() => new Limiter(48000, { ceilingDb: -30 }), RangeError);
  assert.throws(() => new Limiter(48000, { ceilingDb: NaN }), RangeError);
});

test('limiter recovers smoothly after hot input', () => {
  const sr = 48000;
  const lim = new Limiter(sr, { ceilingDb: -3, releaseMs: 50, enabled: true });
  const hot = sineBlocks(100, sr, 0.5, 1.5);
  lim.processBlock(hot, hot, 0, hot.length);
  assert.ok(lim.gain < 0.9, 'gain reduced during hot signal');
  const quiet = sineBlocks(100, sr, 3, 0.1);
  lim.processBlock(quiet, quiet, 0, quiet.length);
  assert.ok(lim.gain > 0.98, `gain should recover, got ${lim.gain}`);
});

test('ParamSmoother approaches target without overshoot', () => {
  const sm = new ParamSmoother(48000, 30, 0);
  sm.setTarget(1);
  let prev = 0;
  for (let i = 0; i < 20000; i++) {
    const v = sm.next();
    assert.ok(v >= prev - 1e-9, 'monotonic approach');
    assert.ok(v <= 1 + 1e-9, 'no overshoot');
    prev = v;
  }
  assert.ok(Math.abs(sm.value - 1) < 0.02);
});

test('db/gain conversions round-trip', () => {
  for (const db of [-24, -6, 0, 6, 20]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9);
  }
});
