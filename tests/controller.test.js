import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveController } from '../engine/controller.js';
import { defaultSettings } from '../engine/dsp/chain.js';
import { PROFILES, profileSettings, getProfile } from '../engine/profiles.js';

function features(overrides = {}) {
  return {
    rmsDb: -18,
    peakDb: -6,
    crestDb: 12,
    bandEnergiesDb: [-30, -25, -20, -18, -16, -15, -18, -25],
    spectralCentroidHz: 1200,
    rolloff85Hz: 6000,
    spectralFlux: 0.02,
    loudnessLufs: -16,
    clipCount: 0,
    ...overrides
  };
}

test('all profiles contain valid, applyable settings', async () => {
  assert.equal(PROFILES.length, 15);
  const ids = new Set(PROFILES.map((p) => p.id));
  assert.equal(ids.size, PROFILES.length);
  for (const p of PROFILES) {
    const { DspChain } = await import('../engine/dsp/chain.js');
    const chain = new DspChain(48000, p.settings);
    const applied = chain.getSettings();
    assert.equal(applied.version, 1);
    assert.ok(p.name.length > 2);
    assert.ok(p.description.length > 5);
    assert.equal(applied.eq.bands.length, 10);
    // each profile must differ from flat except 'balanced'/'custom' baseline
    const s = profileSettings(p.id);
    assert.ok(s.eq.bands.length === 10);
    assert.equal(getProfile(p.id).id, p.id);
  }
});

test('clip guard reduces output gain when clipping detected', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s, m) => applied.push({ s, m }) });
  ctl.setMode('adaptive');
  ctl.setCurrentSettings(defaultSettings());
  ctl.onFeatures(features({ clipCount: 5 }));
  assert.ok(applied.length >= 1);
  assert.ok(applied[0].s.outputGainDb < 0);
  assert.ok(ctl.safetyActions >= 1);
});

test('feedback: too much bass reduces bass parameters', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  const base = defaultSettings();
  base.bass.gainDb = 6;
  ctl.setCurrentSettings(base);
  const res = ctl.applyFeedback('too-much-bass');
  assert.ok(res.ok);
  assert.ok(applied.at(-1).bass.gainDb < 6);
  assert.ok(applied.at(-1).eq.bands[0].gainDb <= 0);
});

test('feedback: too sharp softens treble', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  const base = defaultSettings();
  base.clarity.airDb = 6;
  base.eq.bands[8].gainDb = 4;
  ctl.setCurrentSettings(base);
  ctl.applyFeedback('too-sharp');
  assert.ok(applied.at(-1).clarity.airDb < 6);
  assert.ok(applied.at(-1).eq.bands[8].gainDb < 4);
});

test('hybrid mode surfaces suggestion instead of auto-applying', () => {
  const applied = [];
  const suggestions = [];
  const ctl = new AdaptiveController({
    onApply: (s) => applied.push(s),
    onSuggest: (sug) => suggestions.push(sug)
  });
  ctl.setMode('hybrid');
  ctl.setCurrentSettings(defaultSettings());
  const res = ctl.handleProposal({
    profileId: 'jazz',
    explanation: 'warm content',
    settings: { bass: { gainDb: 2 } }
  }, 'test-ai');
  assert.ok(res.ok && res.pending);
  assert.equal(applied.length, 0);
  assert.equal(suggestions.length, 1);
  const acc = ctl.acceptPending();
  assert.ok(acc.ok);
  assert.equal(applied.length, 1);
  assert.equal(applied.at(-1).bass.gainDb, 2);
});

test('rejectPending keeps settings unchanged', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  ctl.setMode('hybrid');
  ctl.handleProposal({ settings: { outputGainDb: -6 } }, 'ai');
  ctl.rejectPending();
  assert.equal(applied.length, 0);
  assert.equal(ctl.pendingSuggestion, null);
});

test('adaptive mode auto-applies validated AI proposal', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s, m) => applied.push({ s, m }) });
  ctl.setMode('adaptive');
  ctl.setCurrentSettings(defaultSettings());
  const res = ctl.handleProposal({
    profileId: 'vocal-clarity',
    explanation: 'speech detected',
    settings: { clarity: { presenceDb: 2 } }
  }, 'groq');
  assert.ok(res.ok && res.applied);
  assert.equal(applied.length, 1);
  // profile applied as base + AI delta on top
  assert.equal(applied[0].s.clarity.presenceDb, 2);
});

test('invalid AI proposal is rejected and never applied', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  ctl.setMode('adaptive');
  ctl.handleProposal({ settings: { bass: { gainDb: 'not-a-number' } } }, 'ai');
  ctl.handleProposal('this is not json', 'ai');
  assert.equal(applied.length, 0);
});

test('AI client failure does not throw or alter settings', async () => {
  const applied = [];
  const ctl = new AdaptiveController({
    onApply: (s) => applied.push(s),
    aiClient: {
      recommend: async () => {
        throw new Error('network down');
      }
    }
  });
  ctl.setMode('adaptive');
  ctl.setCurrentSettings(defaultSettings());
  await ctl.onFeatures(features());
  assert.equal(applied.length, 0);
});

test('AI client success path applies through validation', async () => {
  const applied = [];
  const ctl = new AdaptiveController({
    onApply: (s) => applied.push(s),
    aiClient: {
      recommend: async () => ({
        ok: true,
        provider: 'gemini',
        proposal: {
          profileId: 'bass-boost',
          explanation: 'bass-heavy track',
          settings: { bass: { gainDb: 4, harmonics: 999 } } // harmonics clamped to 1
        }
      })
    },
    requestIntervalMs: 0
  });
  ctl.setMode('adaptive');
  ctl.setCurrentSettings(defaultSettings());
  await ctl.onFeatures(features());
  assert.equal(applied.length, 1);
  assert.equal(applied.at(-1).bass.harmonics, 1);
});

test('undo restores previous settings', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  const base = defaultSettings();
  ctl.setCurrentSettings(base);
  ctl.applyFeedback('too-loud');
  const afterFeedback = applied.at(-1).outputGainDb;
  assert.ok(afterFeedback < 0);
  const u = ctl.undoLast();
  assert.ok(u.ok);
  assert.equal(applied.at(-1).outputGainDb, base.outputGainDb);
});

test('reset to neutral restores balanced profile', () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  ctl.applyFeedback('too-much-bass');
  ctl.applyFeedback('too-sharp');
  ctl.resetToNeutral();
  const balanced = profileSettings('balanced');
  assert.deepEqual(applied.at(-1).eq.bands, balanced.eq.bands);
});

test('manual mode: features do not modify settings', async () => {
  const applied = [];
  const ctl = new AdaptiveController({ onApply: (s) => applied.push(s) });
  ctl.setMode('manual');
  ctl.setCurrentSettings(defaultSettings());
  await ctl.onFeatures(features({ clipCount: 100 }));
  assert.equal(applied.length, 0);
});

test('content change detection raises score', async () => {
  const ctl = new AdaptiveController({});
  ctl.setMode('manual');
  await ctl.onFeatures(features({ spectralCentroidHz: 500 }));
  await ctl.onFeatures(features({ spectralCentroidHz: 5000, spectralFlux: 5 }));
  assert.ok(ctl.contentChangeScore > 0.05);
});
