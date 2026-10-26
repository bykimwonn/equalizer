import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, machineKeyCryptor, JsonStore } from '../electron/settings-store.js';
import { profileSettings } from '../engine/profiles.js';

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bt-eq-'));
  const store = new SettingsStore(dir, machineKeyCryptor(dir));
  await store.init();
  return { dir, store };
}

test('settings persist across store instances', async () => {
  const { dir, store } = await makeStore();
  await store.setAppSettings({ mode: 'hybrid', audio: { blockFrames: 512 } });
  const store2 = new SettingsStore(dir, machineKeyCryptor(dir));
  await store2.init();
  const s = await store2.getAppSettings();
  assert.equal(s.mode, 'hybrid');
  assert.equal(s.audio.blockFrames, 512);
  assert.equal(s.ai.provider, 'auto'); // defaults survive upgrade merge
  await rm(dir, { recursive: true, force: true });
});

test('API keys are never stored in plain JSON', async () => {
  const { dir, store } = await makeStore();
  await store.setApiKey('groq', 'gsk_super_secret_test_key_123');
  await store.setApiKey('gemini', 'AIza_sy_test_key_456');

  // scan every file in the config dir for the raw key
  const { readdir } = await import('node:fs/promises');
  for (const f of await readdir(dir)) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    assert.ok(!raw.includes('gsk_super_secret_test_key_123'), `key leaked into ${f}`);
    assert.ok(!raw.includes('AIza_sy_test_key_456'), `key leaked into ${f}`);
  }

  // but round-trips through the cryptor
  assert.equal(await store.getApiKey('groq'), 'gsk_super_secret_test_key_123');
  assert.equal(await store.getApiKey('gemini'), 'AIza_sy_test_key_456');

  await store.clearApiKey('groq');
  assert.equal(await store.getApiKey('groq'), null);
  const status = await store.credentialStatus();
  assert.equal(status.groq.configured, false);
  assert.equal(status.gemini.configured, true);
  assert.ok(status.gemini.storage.includes('machine key'));
  await rm(dir, { recursive: true, force: true });
});

test('custom profiles: save / rename / duplicate / delete / export / import', async () => {
  const { dir, store } = await makeStore();
  const settings = profileSettings('rock');
  settings.outputGainDb = -3;

  const saved = await store.saveCustomProfile({ name: 'My Rock', description: 'test', settings });
  assert.ok(saved.id.startsWith('custom-'));
  assert.equal((await store.listCustomProfiles()).length, 1);

  const renamed = await store.saveCustomProfile({ id: saved.id, name: 'Renamed Rock', settings });
  assert.equal(renamed.id, saved.id);
  assert.equal((await store.listCustomProfiles())[0].name, 'Renamed Rock');
  assert.equal((await store.listCustomProfiles()).length, 1, 'rename must not duplicate');

  const exported = await store.exportProfile(saved.id);
  assert.equal(exported.settings.outputGainDb, -3);
  const imported = await store.importProfile({ name: 'Imported', description: 'x', settings: exported.settings });
  assert.equal((await store.listCustomProfiles()).length, 2);

  await store.deleteCustomProfile(saved.id);
  assert.equal((await store.listCustomProfiles()).length, 1);

  await assert.rejects(() => store.importProfile({ name: 'broken' }), TypeError);
  await assert.rejects(() => store.saveCustomProfile({}), TypeError);
  await rm(dir, { recursive: true, force: true });
});

test('personalization: feedback history capped and resettable', async () => {
  const { dir, store } = await makeStore();
  for (let i = 0; i < 250; i++) await store.addFeedback('too-much-bass');
  const pers = await store.getPersonalization();
  assert.equal(pers.feedback.length, 200);
  assert.equal(pers.feedback.at(-1).id, 'too-much-bass');

  await store.setPreferences({ strongerBass: true });
  assert.equal((await store.getPersonalization()).preferences.strongerBass, true);

  await store.resetPersonalization();
  const after = await store.getPersonalization();
  assert.equal(after.feedback.length, 0);
  assert.equal(after.preferences.strongerBass, false);
  await rm(dir, { recursive: true, force: true });
});

test('DSP settings persist and survive corrupt files gracefully', async () => {
  const { dir, store } = await makeStore();
  const s = profileSettings('jazz');
  s.bass.gainDb = 4;
  await store.setDspSettings(s);
  const loaded = await store.getDspSettings();
  assert.equal(loaded.bass.gainDb, 4);

  // corrupt the profiles file → falls back to active profile defaults
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'profiles.json'), '{not json');
  const store2 = new SettingsStore(dir, machineKeyCryptor(dir));
  await store2.init();
  const fallback = await store2.getDspSettings();
  assert.equal(fallback.version, 1);
  assert.equal(fallback.eq.bands.length, 10);
  await rm(dir, { recursive: true, force: true });
});

test('JsonStore atomic writes produce valid JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bt-eq-js-'));
  const js = new JsonStore(path.join(dir, 'x', 'y.json'));
  await Promise.all([1, 2, 3, 4, 5].map((i) => js.write({ i })));
  const final = await js.read();
  assert.ok([1, 2, 3, 4, 5].includes(final.i));
  await rm(dir, { recursive: true, force: true });
});
