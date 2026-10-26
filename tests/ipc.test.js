import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IPC_INVOKE_CHANNELS, IPC_PUSH_CHANNELS, isAllowedInvoke, isAllowedPush } from '../electron/ipc.js';

test('preload allowlist matches the main-process allowlist exactly', async () => {
  const preload = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

  // extract the two channel arrays from preload
  const invokeBlock = preload.match(/INVOKE_CHANNELS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const pushBlock = preload.match(/PUSH_CHANNELS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const parse = (block) =>
    [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const preloadInvoke = parse(invokeBlock).sort();
  const preloadPush = parse(pushBlock).sort();

  assert.deepEqual(preloadInvoke, [...IPC_INVOKE_CHANNELS].sort());
  assert.deepEqual(preloadPush, [...IPC_PUSH_CHANNELS].sort());
});

test('allowlist has no duplicates and covers every required capability', () => {
  assert.equal(new Set(IPC_INVOKE_CHANNELS).size, IPC_INVOKE_CHANNELS.length);
  assert.equal(new Set(IPC_PUSH_CHANNELS).size, IPC_PUSH_CHANNELS.length);
  for (const required of [
    'app:getState',
    'engine:start',
    'engine:setSettings',
    'settings:setApiKey',
    'ai:testProvider',
    'profiles:listAll',
    'personalization:reset'
  ]) {
    assert.ok(isAllowedInvoke(required), `${required} must be allowlisted`);
  }
  assert.ok(isAllowedPush('engine:telemetry'));
  assert.ok(!isAllowedInvoke('shell:exec'));
  assert.ok(!isAllowedInvoke('__proto__'));
  assert.ok(!isAllowedPush('eval'));
});

test('invoke handler registration refuses non-allowlisted channels', async () => {
  const { registerIpc } = await import('../electron/ipc.js');
  const handlers = {};
  const fakeIpcMain = {
    handle(channel, fn) {
      handlers[channel] = fn;
    }
  };
  const fakeHost = {
    on() {},
    status: {},
    controller: {},
    engine: null,
    getTelemetry: () => null,
    async start() { return { ok: true }; },
    async stop() { return { ok: true }; },
    applySettings() {},
    setBypass() { return { ok: true }; },
    async setMode() { return { ok: true }; },
    async enumerateDevices() { return {}; },
    diagnostics() { return {}; }
  };
  const fakeStore = {
    async getAppSettings() { return {}; },
    async setAppSettings() { return {}; },
    async getDspSettings() { return {}; },
    async setDspSettings() { return {}; },
    async credentialStatus() { return {}; },
    async getPersonalization() { return { preferences: {}, feedback: [] }; },
    async setPreferences() {},
    async addFeedback() {},
    async resetPersonalization() {},
    async listCustomProfiles() { return []; },
    async saveCustomProfile(p) { return p; },
    async deleteCustomProfile() { return { ok: true }; },
    async exportProfile() { return null; },
    async importProfile() { return {}; }
  };
  const fakeAi = {
    async testConnection() { return { ok: true }; },
    async listModels() { return { ok: true, models: [] }; },
    async recommend() { return { ok: false }; },
    getStatus() { return {}; },
    invalidate() {}
  };

  // BrowserWindow import is fine in Node — registerIpc only touches it on push
  const { registerIpc: reg } = await import('../electron/ipc.js');
  reg({
    ipcMain: fakeIpcMain,
    settingsStore: fakeStore,
    engineHost: fakeHost,
    aiManager: fakeAi,
    appInfo: { name: 'test' }
  });

  // every registered handler is in the allowlist
  for (const ch of Object.keys(handlers)) {
    assert.ok(isAllowedInvoke(ch), `registered non-allowlisted channel: ${ch}`);
  }
  assert.equal(Object.keys(handlers).length, IPC_INVOKE_CHANNELS.length);

  // handlers return {ok:false,error} instead of throwing
  const bad = await handlers['engine:setSettings']({ settings: 'not-an-object' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0);

  const key = await handlers['settings:setApiKey']({ provider: 'groq', apiKey: 'short' });
  assert.equal(key.ok, false);
});
