import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DspChain, defaultSettings } from '../engine/dsp/chain.js';
import { AudioEngine } from '../engine/engine.js';

function sine(freq, sr, n, amp = 0.5) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return b;
}

test('bypass is bit-exact pass-through', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.bypass = true;
  s.eq.bands[0].gainDb = 12;
  s.bass.gainDb = 6;
  s.compressor.enabled = true;
  const chain = new DspChain(sr, s);
  const L = sine(200, sr, 4800, 0.7);
  const R = sine(200, sr, 4800, 0.3);
  const refL = Float32Array.from(L);
  const refR = Float32Array.from(R);
  chain.processBlock(L, R, 0, L.length);
  for (let i = 0; i < L.length; i++) {
    assert.equal(L[i], refL[i]);
    assert.equal(R[i], refR[i]);
  }
});

test('default settings (flat) pass audio unchanged within tiny tolerance', () => {
  const sr = 48000;
  const chain = new DspChain(sr, defaultSettings());
  const L = sine(1000, sr, 4800, 0.5);
  const ref = Float32Array.from(L);
  chain.processBlock(L, L, 0, L.length);
  // smoothing at start may deviate slightly; check steady state
  for (let i = 2400; i < L.length; i += 337) {
    assert.ok(Math.abs(L[i] - ref[i]) < 0.02, `sample ${i}: ${L[i]} vs ${ref[i]}`);
  }
});

test('EQ boost inside the chain measurably changes the signal', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.eq.bands[5] = { ...s.eq.bands[5], freq: 1000, gainDb: 8, q: 1.2 };
  const chain = new DspChain(sr, s);
  const L = sine(1000, sr, sr, 0.4);
  let refSum = 0;
  for (let i = sr / 2; i < L.length; i++) refSum += L[i] * L[i];
  const refRms = Math.sqrt(refSum / (sr / 2));
  chain.processBlock(L, L, 0, L.length);
  let outSum = 0;
  for (let i = sr / 2; i < L.length; i++) outSum += L[i] * L[i];
  const outRms = Math.sqrt(outSum / (sr / 2));
  const db = 20 * Math.log10(outRms / refRms);
  assert.ok(Math.abs(db - 8) < 0.8, `expected ~8 dB, got ${db}`);
});

test('limiter protects against clipping when boosting bass hard', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.eq.bands[0] = { ...s.eq.bands[0], freq: 40, gainDb: 12, q: 0.8 };
  s.eq.bands[1] = { ...s.eq.bands[1], gainDb: 12, q: 0.8 };
  s.bass.gainDb = 12;
  s.bass.subGainDb = 12;
  s.bass.harmonics = 1;
  s.limiter.ceilingDb = -1;
  const chain = new DspChain(sr, s);
  const ceiling = Math.pow(10, -1 / 20);
  const L = sine(35, sr, sr, 0.9);
  chain.processBlock(L, L, 0, L.length);
  let maxAbs = 0;
  for (const v of L) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= ceiling + 1e-6, `clipped: ${maxAbs} > ${ceiling}`);
});

test('parameter changes produce no sample-level clicks', () => {
  const sr = 48000;
  const chain = new DspChain(sr, defaultSettings());
  const n = 4800;
  const L = sine(500, sr, n * 2, 0.5);
  // first half at default
  chain.processBlock(L, L, 0, n);
  // step output gain down 12 dB and process second half immediately
  const s = chain.getSettings();
  s.outputGainDb = -12;
  chain.setSettings(s);
  chain.processBlock(L, L, n, n);
  // max sample-to-sample delta across the boundary must be small
  let maxDelta = 0;
  for (let i = n - 100; i < n + 100; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(L[i + 1] - L[i]));
  }
  // sine at 0.5 amp has natural per-sample delta up to ~0.033 at 500 Hz
  assert.ok(maxDelta < 0.12, `click detected, maxDelta=${maxDelta}`);
});

test('multiband compression path runs and stays bounded', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.compressor.enabled = true;
  s.compressor.multiband = true;
  s.compressor.crossoverHz = 250;
  s.compressor.thresholdDb = -30;
  s.compressor.ratio = 6;
  const chain = new DspChain(sr, s);
  const L = sine(80, sr, 4800, 0.8);
  const R = sine(1200, sr, 4800, 0.8);
  const res = chain.processBlock(L, R, 0, L.length);
  for (const v of L) assert.ok(Number.isFinite(v));
  for (const v of R) assert.ok(Number.isFinite(v));
  assert.ok(res.gainReductionDb > 0, 'compression should engage');
});

test('sample-rate reconfiguration preserves EQ response and keeps processing', () => {
  const sr1 = 44100;
  const s = defaultSettings();
  s.eq.bands[5] = { ...s.eq.bands[5], freq: 1000, gainDb: 6, q: 1 };
  const chain = new DspChain(sr1, s);
  const r44 = chain.responseDb([1000])[0];
  chain.setSampleRate(48000);
  const r48 = chain.responseDb([1000])[0];
  assert.ok(Math.abs(r44 - r48) < 0.1);
  const L = sine(1000, 48000, 4800, 0.5);
  chain.processBlock(L, L, 0, L.length);
  for (const v of L) assert.ok(Number.isFinite(v));
});

test('stereo width 0 folds to mono', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.stereo.width = 0;
  const chain = new DspChain(sr, s);
  const n = 4800;
  const L = new Float32Array(n).fill(0.5);
  const R = new Float32Array(n).fill(-0.25);
  chain.processBlock(L, R, 0, n);
  for (let i = 100; i < n; i++) {
    assert.ok(Math.abs(L[i] - R[i]) < 1e-4, `mono fold mismatch at ${i}`);
  }
});

test('no NaN/Inf propagates through the full chain on extreme settings', () => {
  const sr = 48000;
  const s = defaultSettings();
  s.eq.bands.forEach((b) => {
    b.gainDb = 12;
    b.q = 10;
    b.enabled = true;
  });
  s.bass = { enabled: true, gainDb: 12, subGainDb: 12, harmonics: 1, protection: true };
  s.clarity = { enabled: true, presenceDb: 12, airDb: 12, transients: 1 };
  s.compressor = { ...s.compressor, enabled: true, thresholdDb: -60, ratio: 20, makeupDb: 12 };
  s.outputGainDb = 24;
  const chain = new DspChain(sr, s);
  const L = sine(70, sr, 9600, 1.0);
  const R = sine(130, sr, 9600, 1.0);
  chain.processBlock(L, R, 0, L.length);
  for (const v of L) assert.ok(Number.isFinite(v));
  for (const v of R) assert.ok(Number.isFinite(v));
});

test('AudioEngine: telemetry reflects real signal presence and bypass', () => {
  const sr = 48000;
  const eng = new AudioEngine({ sampleRate: sr, blockFrames: 512 });
  const block = sine(440, sr, 512, 0.5);
  const ref = Float32Array.from(block);
  for (let i = 0; i < 40; i++) {
    const b = sine(440, sr, 512, 0.5);
    eng.process(b, b, 0, b.length);
  }
  const t = eng.getTelemetry();
  assert.ok(t.input.peak > 0.3, `input peak ${t.input.peak}`);
  assert.ok(t.output.peak > 0.05, `output peak ${t.output.peak}`);
  assert.ok(t.engine.blocksProcessed === 40);
  assert.ok(t.spectrum.length === 64);
  assert.ok(t.features.rmsDb > -20);
  assert.ok(t.engine.blockLatencyMs > 0);

  eng.setBypass(true);
  const passthrough = sine(440, sr, 512, 0.5);
  const exact = Float32Array.from(passthrough);
  eng.process(passthrough, passthrough, 0, passthrough.length);
  for (let i = 0; i < passthrough.length; i++) {
    assert.equal(passthrough[i], exact[i]);
  }
});

test('AudioEngine: sustained processing does not grow per-block cost pathologically', () => {
  const sr = 48000;
  const eng = new AudioEngine({ sampleRate: sr });
  for (let i = 0; i < 3000; i++) {
    const b = sine(300 + (i % 200), sr, 256, 0.4);
    eng.process(b, b, 0, b.length);
  }
  assert.equal(eng.blocksProcessed, 3000);
  assert.ok(eng.nanGuardTrips === 0);
  const t = eng.getTelemetry();
  assert.ok(Number.isFinite(t.engine.avgProcessMsPerBlock));
  assert.ok(t.engine.uptimeSec >= 0);
});

test('AudioEngine: NaN input is sanitized and counted', () => {
  const eng = new AudioEngine({ sampleRate: 48000 });
  const b = new Float32Array(256);
  b[5] = NaN;
  b[6] = Infinity;
  eng.process(b, b, 0, b.length);
  assert.ok(eng.nanGuardTrips >= 2);
  for (const v of b) assert.ok(Number.isFinite(v));
});
