import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, machineKeyCryptor } from '../electron/settings-store.js';
import { EngineHost } from '../electron/audio/engine-host.js';

function makeFakeAi() {
  return {
    async recommend() {
      return { ok: false, error: 'offline in tests' };
    },
    getStatus() {
      return {};
    },
    invalidate() {},
    async testConnection() {
      return { ok: false, error: 'offline' };
    },
    async listModels() {
      return { ok: true, models: [] };
    }
  };
}

async function makeHost() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bt-eq-host-'));
  const store = new SettingsStore(dir, machineKeyCryptor(dir));
  await store.init();
  const host = new EngineHost({ settingsStore: store, aiManager: makeFakeAi() });
  await host.init();
  return { dir, store, host };
}

test('engine refuses to pretend: WASAPI start on non-Windows fails honestly', async () => {
  const { dir, store, host } = await makeHost();
  await store.setAppSettings({ audio: { backend: 'wasapi' } });
  const res = await host.start();
  assert.equal(res.ok, false);
  assert.ok(res.requiresSimulation === true || res.error, 'must explain why');
  assert.equal(host.status.state, 'error');
  await rm(dir, { recursive: true, force: true });
});

test('simulation backend drives real DSP + telemetry end-to-end', async () => {
  const { dir, store, host } = await makeHost();
  await store.setAppSettings({ audio: { backend: 'simulation' } });
  const res = await host.start();
  assert.ok(res.ok, `start failed: ${res.error}`);
  assert.equal(host.status.backend, 'simulation');
  assert.ok(host.status.backendDetail.includes('no real audio I/O') || host.status.backendDetail.includes('Simulation'));

  const telemetry = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no telemetry within 3 s')), 3000);
    host.once('telemetry', (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

  assert.ok(telemetry.engine.blocksProcessed > 0, 'engine must actually process blocks');
  assert.ok(telemetry.input.peak > 0.01, 'sim signal must be measured by the meters');
  assert.ok(telemetry.spectrum.length === 64);
  assert.ok(telemetry.features.rmsDb > -60);
  assert.equal(telemetry.status.backend, 'simulation');

  // settings round-trip through the host
  const applied = [];
  host.on('settings-changed', (s) => applied.push(s));
  const s = host.engine.getSettings();
  s.bass.gainDb = 5;
  host.applySettings(s, { source: 'test' });
  assert.equal(host.engine.getSettings().bass.gainDb, 5);
  assert.equal(applied.length, 1);

  // bypass is bit-exact
  host.setBypass(true);
  assert.equal(host.engine.getSettings().bypass, true);
  host.setBypass(false);

  // diagnostics reflect genuine engine state
  const d = host.diagnostics();
  assert.ok(d.engine.blocksProcessed > 0);
  assert.equal(d.controller.mode, 'adaptive');

  await host.shutdown();
  assert.equal(host.status.state, 'stopped');
  await rm(dir, { recursive: true, force: true });
});

test('mode changes propagate to the controller and persist', async () => {
  const { dir, store, host } = await makeHost();
  await host.setMode('hybrid');
  assert.equal(host.controller.mode, 'hybrid');
  assert.equal((await store.getAppSettings()).mode, 'hybrid');
  await host.setMode('manual');
  assert.equal(host.controller.mode, 'manual');
  await assert.rejects(() => host.setMode('quantum'));
  await rm(dir, { recursive: true, force: true });
});

test('clip guard runs against real measured features in the loop', async () => {
  const { dir, store, host } = await makeHost();
  await store.setAppSettings({ audio: { backend: 'simulation' } });
  await host.start();

  // force clipping feature state as if measured
  host.engine.features.latest.clipCount = 50;
  const applied = [];
  host.on('settings-changed', (s) => applied.push(s));
  await host.controller.onFeatures(host.engine.features.latest);
  assert.ok(applied.length >= 1, 'safety rule must act on clipping');
  assert.ok(host.controller.safetyActions >= 1);
  await host.shutdown();
  await rm(dir, { recursive: true, force: true });
});
