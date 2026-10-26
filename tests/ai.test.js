import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, machineKeyCryptor } from '../electron/settings-store.js';
import { AiManager } from '../electron/ai/manager.js';
import { buildSystemPrompt, buildUserMessage, GROQ_DEFAULT_MODEL } from '../electron/ai/groq.js';
import { GEMINI_DEFAULT_MODEL } from '../electron/ai/gemini.js';

const features = {
  rmsDb: -18,
  peakDb: -6,
  crestDb: 12,
  bandEnergiesDb: [-30, -25, -20, -18, -16, -15, -18, -25],
  spectralCentroidHz: 1200,
  rolloff85Hz: 6000,
  spectralFlux: 0.02,
  loudnessLufs: -16,
  clipCount: 0
};

async function makeManager(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bt-eq-ai-'));
  const store = new SettingsStore(dir, machineKeyCryptor(dir));
  await store.init();
  const calls = { groq: [], gemini: [] };
  const providerFactory = async (name, { apiKey, model }) => {
    calls[name].push({ apiKey, model });
    const behavior = overrides[name] ?? {};
    return {
      id: name,
      model,
      async recommend() {
        if (behavior.throwError) throw new Error(behavior.throwError);
        return behavior.response ?? JSON.stringify({
          profileId: 'jazz',
          explanation: 'warm balanced content',
          confidence: 0.7,
          settings: { bass: { gainDb: 2 } }
        });
      },
      async testConnection() {
        if (behavior.throwError) throw new Error(behavior.throwError);
        const models = await this.listModels();
        return { ok: true, modelCount: models.length, reply: 'OK', models: models.slice(0, 50) };
      },
      async listModels() {
        if (behavior.throwError) throw new Error(behavior.throwError);
        return behavior.models ?? [{ id: model, label: model }, { id: 'other-model', label: 'other' }];
      },
      setModel() {}
    };
  };
  const mgr = new AiManager({ settingsStore: store, providerFactory });
  return { dir, store, mgr, calls };
}

test('recommend is rejected when no provider is configured', async () => {
  const { dir, mgr } = await makeManager();
  const res = await mgr.recommend(features, {}, 'adaptive');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('not configured'));
  await rm(dir, { recursive: true, force: true });
});

test('groq path: validated proposal returned with provider identity', async () => {
  const { dir, store, mgr, calls } = await makeManager();
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  const res = await mgr.recommend(features, { clearerVocals: true }, 'adaptive', { force: true });
  assert.ok(res.ok);
  assert.equal(res.provider, 'groq');
  assert.equal(res.validated.settings.bass.gainDb, 2);
  assert.equal(res.proposal.profileId, 'jazz');
  assert.equal(calls.groq[0].model, GROQ_DEFAULT_MODEL);
  await rm(dir, { recursive: true, force: true });
});

test('fallback: groq failure → gemini succeeds', async () => {
  const { dir, store, mgr } = await makeManager({
    groq: { throwError: 'quota exceeded' },
    gemini: {
      response: JSON.stringify({ profileId: 'podcast', settings: { clarity: { presenceDb: 3 } } })
    }
  });
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  await store.setApiKey('gemini', 'AIza_test_key_abcdefgh');
  const res = await mgr.recommend(features, {}, 'hybrid', { force: true });
  assert.ok(res.ok);
  assert.equal(res.provider, 'gemini');
  assert.equal(res.validated.settings.clarity.presenceDb, 3);
  const status = mgr.getStatus();
  assert.ok(status.groq.lastError.includes('quota'));
  await rm(dir, { recursive: true, force: true });
});

test('no fallback configured → single provider only', async () => {
  const { dir, store, mgr } = await makeManager({ groq: { throwError: 'down' } });
  await store.setAppSettings({ ai: { fallback: false } });
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  await store.setApiKey('gemini', 'AIza_test_key_abcdefgh');
  const res = await mgr.recommend(features, {}, 'adaptive', { force: true });
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes('gemini'), 'gemini must not be tried when fallback is off');
  await rm(dir, { recursive: true, force: true });
});

test('malformed AI output is rejected without touching settings', async () => {
  const { dir, store, mgr } = await makeManager({
    groq: { response: 'I think you should set gain to eleven!' }
  });
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  const res = await mgr.recommend(features, {}, 'adaptive', { force: true });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('rejected') || res.error.includes('parse'));
  await rm(dir, { recursive: true, force: true });
});

test('unsafe numeric proposals are clamped or rejected before return', async () => {
  const { dir, store, mgr } = await makeManager({
    groq: {
      response: JSON.stringify({
        settings: {
          outputGainDb: 999,
          limiter: { ceilingDb: -0.01 },
          eq: { bands: [{ id: 5, gainDb: -50 }] }
        }
      })
    }
  });
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  const res = await mgr.recommend(features, {}, 'adaptive', { force: true });
  assert.ok(res.ok);
  assert.equal(res.validated.settings.outputGainDb, 24);
  assert.equal(res.validated.settings.eq.bands[5].gainDb, -12);
  assert.ok(res.warnings.length >= 2);
  await rm(dir, { recursive: true, force: true });
});

test('request throttling respects the configured interval', async () => {
  const { dir, store, mgr } = await makeManager();
  await store.setApiKey('groq', 'gsk_test_key_abcdefgh');
  const first = await mgr.recommend(features, {}, 'adaptive', { force: true });
  assert.ok(first.ok);
  const second = await mgr.recommend(features, {}, 'adaptive');
  assert.equal(second.ok, false);
  assert.equal(second.throttled, true);
  await rm(dir, { recursive: true, force: true });
});

test('testConnection reports genuine latency and model list', async () => {
  const { dir, store, mgr } = await makeManager();
  await store.setApiKey('gemini', 'AIza_test_key_abcdefgh');
  const res = await mgr.testConnection('gemini');
  assert.ok(res.ok);
  assert.equal(res.modelCount, 2);
  assert.ok(res.latencyMs >= 0);
  const models = await mgr.listModels('gemini');
  assert.equal(models.models.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('feature summaries contain only compact numeric fields (no raw audio)', () => {
  const msg = buildUserMessage(features, { naturalSound: true }, 'adaptive');
  const parsed = JSON.parse(msg);
  assert.equal(parsed.task, 'recommend-dsp-settings');
  assert.deepEqual(Object.keys(parsed.features).sort(), [
    'bandEnergiesDb',
    'clipCount',
    'crestDb',
    'loudnessLufs',
    'peakDb',
    'rolloff85Hz',
    'rmsDb',
    'spectralCentroidHz',
    'spectralFlux'
  ].sort());
  assert.ok(msg.length < 2000, 'summaries must stay compact');
  const sys = buildSystemPrompt();
  assert.ok(sys.includes('STRICT JSON'));
  assert.ok(sys.includes('NEVER receive raw audio'));
});

test('provider defaults are documented and interchangeable', () => {
  assert.equal(typeof GROQ_DEFAULT_MODEL, 'string');
  assert.equal(typeof GEMINI_DEFAULT_MODEL, 'string');
  assert.ok(GROQ_DEFAULT_MODEL.length > 3);
  assert.ok(GEMINI_DEFAULT_MODEL.length > 3);
});
