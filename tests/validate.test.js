import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiSettings, parseAiProposal, BOUNDS } from '../engine/validate.js';
import { defaultSettings } from '../engine/dsp/chain.js';

test('valid proposal applies with clamped ranges reported', () => {
  const res = validateAiSettings({
    eq: { bands: [{ id: 5, gainDb: 99 }] }, // over max → clamp
    bass: { gainDb: 3, harmonics: 0.5 }
  });
  assert.ok(res.ok);
  assert.equal(res.settings.eq.bands[5].gainDb, 12);
  assert.equal(res.settings.bass.gainDb, 3);
  assert.ok(res.warnings.some((w) => w.includes('clamped')));
  assert.ok(res.appliedFields >= 3);
});

test('NaN / non-numeric fields are rejected, not silently applied', () => {
  // when nothing valid applies, the whole proposal is rejected
  const allBad = validateAiSettings({
    eq: { bands: [{ id: 5, gainDb: 'rm -rf' }] },
    bass: { gainDb: NaN }
  });
  assert.equal(allBad.ok, false);
  assert.equal(allBad.settings, null);
  assert.ok(allBad.errors.length >= 2);

  // mixed proposal: valid fields apply, invalid fields drop with errors
  const mixed = validateAiSettings({
    eq: { bands: [{ id: 5, gainDb: 'rm -rf' }, { id: 3, gainDb: 2 }] },
    bass: { gainDb: NaN, harmonics: 0.4 }
  });
  assert.ok(mixed.ok);
  assert.ok(mixed.errors.length >= 2);
  assert.equal(mixed.settings.eq.bands[5].gainDb, 0); // untouched default, string never applied
  assert.equal(mixed.settings.eq.bands[3].gainDb, 2);
  assert.equal(mixed.settings.bass.harmonics, 0.4);
  assert.ok(Number.isFinite(mixed.settings.bass.gainDb));
});

test('prototype pollution and unknown keys are ignored', () => {
  const res = validateAiSettings({
    __proto__: { polluted: true },
    constructor: { prototype: { hacked: true } },
    evil: 'do something',
    bass: { gainDb: 2, unknownModuleKey: 'x' },
    eq: { bands: [{ id: 0, gainDb: 1, exec: 'code' }] }
  });
  assert.ok(res.ok);
  assert.equal(res.settings.bass.gainDb, 2);
  assert.equal(res.settings.bass.unknownModuleKey, undefined);
  assert.equal(res.settings.eq.bands[0].exec, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal({}.hacked, undefined);
});

test('invalid band index is reported and does not corrupt other bands', () => {
  const base = defaultSettings();
  base.eq.bands[3].gainDb = 4;
  const res = validateAiSettings({ eq: { bands: [{ id: 99, gainDb: 5 }, { id: 3, gainDb: -2 }] } }, base);
  assert.ok(res.errors.some((e) => e.includes('99')));
  assert.equal(res.settings.eq.bands[3].gainDb, -2);
  assert.equal(res.settings.eq.bands[0].gainDb, base.eq.bands[0].gainDb);
});

test('invalid filter type rejected', () => {
  const res = validateAiSettings({ eq: { bands: [{ id: 1, type: 'quantum' }] } });
  assert.ok(res.errors.some((e) => e.includes('type')));
});

test('completely invalid proposal returns ok:false', () => {
  assert.equal(validateAiSettings(null).ok, false);
  assert.equal(validateAiSettings('text').ok, false);
  assert.equal(validateAiSettings([]).ok, false);
  const res = validateAiSettings({ eq: { bands: [{ id: 5, gainDb: 'x' }] } });
  assert.equal(res.ok, false);
  assert.equal(res.appliedFields, 0);
});

test('limiter ceiling cannot be proposed hotter than safe bounds', () => {
  const res = validateAiSettings({ limiter: { ceilingDb: -0.1 } });
  assert.ok(res.ok);
  assert.equal(res.settings.limiter.ceilingDb, BOUNDS.limiter.ceilingDb[1]);
});

test('parseAiProposal handles fenced JSON, prose, and garbage', () => {
  const fenced = 'Here is my analysis:\n```json\n{"profileId":"jazz","explanation":"warm","confidence":0.8,"settings":{"bass":{"gainDb":2}}}\n```';
  const r1 = parseAiProposal(fenced);
  assert.ok(r1.ok);
  assert.equal(r1.proposal.profileId, 'jazz');
  assert.equal(r1.proposal.settings.bass.gainDb, 2);

  const prose = 'Result: {"profileId":"rock","settings":{}} done.';
  const r2 = parseAiProposal(prose);
  assert.ok(r2.ok);
  assert.equal(r2.proposal.profileId, 'rock');

  assert.equal(parseAiProposal('not json at all').ok, false);
  assert.equal(parseAiProposal('').ok, false);
  assert.equal(parseAiProposal(123).ok, false);
});

test('confidence is clamped to 0..1', () => {
  const r = parseAiProposal('{"confidence":5,"settings":{}}');
  assert.equal(r.proposal.confidence, 1);
  const r2 = parseAiProposal('{"confidence":-2,"settings":{}}');
  assert.equal(r2.proposal.confidence, 0);
});

test('booleans must be boolean', () => {
  const res = validateAiSettings({ compressor: { enabled: 'yes' } });
  assert.ok(res.errors.some((e) => e.includes('boolean')));
});
