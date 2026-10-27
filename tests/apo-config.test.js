import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeApoConfig,
  parseApoConfig,
  APO_MAGIC,
  APO_VERSION,
  APO_FILE_SIZE,
  APO_PARAMS_SIZE,
  APO_HEADER_SIZE,
  EQBAND_SIZE
} from '../engine/apo-config.js';
import { defaultSettings } from '../engine/dsp/chain.js';
import { profileSettings } from '../engine/profiles.js';

const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

test('file layout: header and payload sizes are exact', () => {
  const bytes = serializeApoConfig(defaultSettings());
  const dv = dvOf(bytes);
  assert.equal(bytes.length, APO_FILE_SIZE);
  assert.equal(APO_FILE_SIZE, 12 + 216);
  assert.equal(APO_PARAMS_SIZE, 216);
  assert.equal(EQBAND_SIZE, 20);
  assert.equal(dv.getUint32(0, true), APO_MAGIC);
  assert.equal(dv.getUint32(4, true), APO_VERSION);
  assert.equal(dv.getUint32(8, true), APO_PARAMS_SIZE);
});

test('values round-trip byte-exactly through the packed layout', () => {
  const s = profileSettings('deep-bass');
  s.inputGainDb = -2.5;
  s.outputGainDb = 3.25;
  s.bypass = true;
  s.eq.bands[5] = { id: 5, type: 'lowshelf', freq: 750, gainDb: -4.5, q: 2.25, enabled: true };
  s.eq.bands[7].enabled = false;

  const parsed = parseApoConfig(serializeApoConfig(s));
  assert.equal(parsed.version, APO_VERSION);
  assert.equal(parsed.inputGainDb, -2.5);
  assert.equal(parsed.outputGainDb, 3.25);
  assert.equal(parsed.bypass, true);
  assert.equal(parsed.bands[5].freq, 750);
  assert.equal(parsed.bands[5].gainDb, -4.5);
  assert.equal(parsed.bands[5].q, 2.25);
  assert.equal(parsed.bands[5].type, 1); // lowshelf
  assert.equal(parsed.bands[5].enabled, true);
  assert.equal(parsed.bands[7].enabled, false);
  assert.equal(parsed.limiterCeilingDb, s.limiter.ceilingDb);
});

test('field offsets match the C++ struct (padding-free contract)', () => {
  const s = defaultSettings();
  s.inputGainDb = 1;
  s.outputGainDb = 2;
  s.limiter.ceilingDb = -3;
  s.bypass = false;
  s.eq.bands[0] = { id: 0, type: 'highshelf', freq: 100, gainDb: 5, q: 3, enabled: true };
  const dv = dvOf(serializeApoConfig(s));
  const base = APO_HEADER_SIZE;
  assert.equal(dv.getFloat32(base + 0, true), 1);
  assert.equal(dv.getFloat32(base + 4, true), 2);
  // band 0 at base+8: freq@+0 q@+4 gainDb@+8 type@+12 enabled@+16
  assert.equal(dv.getFloat32(base + 8 + 0, true), 100);
  assert.equal(dv.getFloat32(base + 8 + 4, true), 3);
  assert.equal(dv.getFloat32(base + 8 + 8, true), 5);
  assert.equal(dv.getInt32(base + 8 + 12, true), 2); // highshelf
  assert.equal(dv.getInt32(base + 8 + 16, true), 1);
  // band 1 starts exactly 20 bytes later
  assert.equal(dv.getFloat32(base + 8 + EQBAND_SIZE + 0, true), s.eq.bands[1].freq);
  // trailing fields
  assert.equal(dv.getFloat32(base + 208, true), -3);
  assert.equal(dv.getInt32(base + 212, true), 0);
});

test('neutral fallback for missing bands and unsafe ceiling is clamped', () => {
  const parsed = parseApoConfig(serializeApoConfig({ eq: { bands: [null, null] } }));
  assert.equal(parsed.bands.length, 10);
  assert.equal(parsed.bands[3].freq, 1000); // neutral
  assert.equal(parsed.bands[3].gainDb, 0);
  assert.equal(parsed.bands[3].enabled, true);

  const hot = parseApoConfig(serializeApoConfig({ limiter: { ceilingDb: -0.01 } }));
  assert.equal(hot.limiterCeilingDb, -0.5, 'ceiling can never serialize hotter than -0.5 dBFS');
});

test('EQ disabled forces all bands to enabled=0', () => {
  const s = defaultSettings();
  s.eq.enabled = false;
  const parsed = parseApoConfig(serializeApoConfig(s));
  for (const b of parsed.bands) assert.equal(b.enabled, false);
});

test('parse rejects garbage and truncated buffers', () => {
  assert.throws(() => parseApoConfig(new Uint8Array(5)), RangeError);
  const bad = serializeApoConfig(defaultSettings());
  dvOf(bad).setUint32(0, 0xdeadbeef, true);
  assert.throws(() => parseApoConfig(bad), RangeError);
  assert.throws(() => parseApoConfig(serializeApoConfig(defaultSettings()).subarray(0, 100)), RangeError);
});

test('profiles serialize without layout errors', () => {
  for (const id of ['balanced', 'bass-boost', 'podcast', 'night', 'custom']) {
    const bytes = serializeApoConfig(profileSettings(id));
    assert.equal(bytes.length, APO_FILE_SIZE, id);
    const parsed = parseApoConfig(bytes);
    assert.equal(parsed.bands.length, 10, id);
  }
});
