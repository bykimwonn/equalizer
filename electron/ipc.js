/**
 * IPC layer — strict allowlist of channels, input validation on every handler.
 * The renderer can only reach these handlers via the preload bridge.
 *
 * Note: this module deliberately does NOT import 'electron' so it can be
 * unit-tested in plain Node; the window list is injected by main.js.
 */

export const IPC_INVOKE_CHANNELS = Object.freeze([
  'app:getState',
  'app:setLoginItem',
  'engine:start',
  'engine:stop',
  'engine:setSettings',
  'engine:setMode',
  'engine:setBypass',
  'engine:applyFeedback',
  'engine:acceptSuggestion',
  'engine:rejectSuggestion',
  'engine:undo',
  'engine:resetNeutral',
  'engine:diagnostics',
  'devices:enumerate',
  'settings:get',
  'settings:set',
  'settings:setApiKey',
  'settings:clearApiKey',
  'settings:credentialStatus',
  'profiles:listAll',
  'profiles:saveCustom',
  'profiles:deleteCustom',
  'profiles:export',
  'profiles:import',
  'personalization:get',
  'personalization:setPreferences',
  'personalization:addFeedback',
  'personalization:reset',
  'ai:testProvider',
  'ai:listModels',
  'ai:requestRecommendation',
  'ai:status'
]);

export const IPC_PUSH_CHANNELS = Object.freeze([
  'engine:telemetry',
  'engine:status',
  'ai:suggestion',
  'settings:changed'
]);

export function isAllowedInvoke(channel) {
  return IPC_INVOKE_CHANNELS.includes(channel);
}

export function isAllowedPush(channel) {
  return IPC_PUSH_CHANNELS.includes(channel);
}

function assertObject(v, name) {
  if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new TypeError(`${name} must be an object`);
  }
}

/**
 * Register all IPC handlers. Each handler validates its input.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain (or a test double)
 * @param {() => Array} [deps.getWindows] returns BrowserWindows to push to
 */
export function registerIpc({ ipcMain, settingsStore, engineHost, aiManager, appInfo, getWindows = () => [], setLoginItem = null }) {
  const handle = (channel, fn) => {
    if (!isAllowedInvoke(channel)) throw new Error(`refusing to register non-allowlisted channel ${channel}`);
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await fn(payload ?? {});
      } catch (e) {
        return { ok: false, error: String(e.message ?? e) };
      }
    });
  };

  const broadcast = (channel, data) => {
    if (!isAllowedPush(channel)) throw new Error(`refusing to push on non-allowlisted channel ${channel}`);
    for (const win of getWindows()) {
      if (win && !win.isDestroyed?.()) win.webContents.send(channel, data);
    }
  };

  engineHost.on('telemetry', (t) => broadcast('engine:telemetry', t));
  engineHost.on('status', (s) => broadcast('engine:status', s));
  engineHost.on('ai-suggestion', (s) => broadcast('ai:suggestion', s));
  engineHost.on('settings-changed', (s) => broadcast('settings:changed', s));

  handle('app:getState', async () => {
    const [settings, dsp, creds, pers] = await Promise.all([
      settingsStore.getAppSettings(),
      settingsStore.getDspSettings(),
      settingsStore.credentialStatus(),
      settingsStore.getPersonalization()
    ]);
    return {
      ok: true,
      app: appInfo,
      settings,
      dsp,
      credentials: creds,
      personalization: pers,
      engineStatus: engineHost.status,
      backends: engineHost.backendStatus()
    };
  });

  handle('app:setLoginItem', async (payload) => {
    const enabled = payload?.enabled === true;
    if (setLoginItem) setLoginItem(enabled);
    return { ok: true, enabled };
  });

  handle('engine:start', () => engineHost.start());
  handle('engine:stop', () => engineHost.stop());
  handle('engine:setSettings', async (payload) => {
    assertObject(payload, 'payload');
    if (!payload.settings || typeof payload.settings !== 'object') {
      throw new TypeError('settings object required');
    }
    engineHost.applySettings(payload.settings, { source: 'user' });
    return { ok: true };
  });
  handle('engine:setMode', async (payload) => {
    const mode = String(payload.mode ?? '');
    return engineHost.setMode(mode);
  });
  handle('engine:setBypass', async (payload) => engineHost.setBypass(payload.bypass === true));
  handle('engine:applyFeedback', async (payload) => {
    const res = engineHost.controller.applyFeedback(String(payload.id ?? ''));
    return res;
  });
  handle('engine:acceptSuggestion', () => engineHost.controller.acceptPending());
  handle('engine:rejectSuggestion', () => engineHost.controller.rejectPending());
  handle('engine:undo', () => engineHost.controller.undoLast());
  handle('engine:resetNeutral', () => engineHost.controller.resetToNeutral());
  handle('engine:diagnostics', () => ({ ok: true, diagnostics: engineHost.diagnostics() }));

  handle('devices:enumerate', () => engineHost.enumerateDevices());

  handle('settings:get', async () => ({ ok: true, settings: await settingsStore.getAppSettings() }));
  handle('settings:set', async (payload) => {
    assertObject(payload.patch, 'patch');
    await settingsStore.setAppSettings(payload.patch);
    return { ok: true, settings: await settingsStore.getAppSettings() };
  });
  handle('settings:setApiKey', async (payload) => {
    const provider = String(payload.provider ?? '');
    const apiKey = String(payload.apiKey ?? '');
    if (!apiKey || apiKey.length < 8) throw new TypeError('API key looks invalid');
    const res = await settingsStore.setApiKey(provider, apiKey);
    aiManager.invalidate(provider);
    return res;
  });
  handle('settings:clearApiKey', async (payload) => {
    const res = await settingsStore.clearApiKey(String(payload.provider ?? ''));
    aiManager.invalidate(String(payload.provider ?? ''));
    return res;
  });
  handle('settings:credentialStatus', async () => ({ ok: true, credentials: await settingsStore.credentialStatus() }));

  handle('profiles:listAll', async () => {
    const { PROFILES, profileSettings } = await import('../engine/profiles.js');
    const custom = await settingsStore.listCustomProfiles();
    return {
      ok: true,
      builtin: PROFILES.map((p) => ({ id: p.id, name: p.name, description: p.description, settings: profileSettings(p.id) })),
      custom
    };
  });
  handle('profiles:saveCustom', (payload) => settingsStore.saveCustomProfile(payload.profile));
  handle('profiles:deleteCustom', (payload) => settingsStore.deleteCustomProfile(String(payload.id ?? '')));
  handle('profiles:export', (payload) => settingsStore.exportProfile(String(payload.id ?? '')));
  handle('profiles:import', (payload) => settingsStore.importProfile(payload.profile));

  handle('personalization:get', async () => ({ ok: true, personalization: await settingsStore.getPersonalization() }));
  handle('personalization:setPreferences', async (payload) => {
    assertObject(payload.preferences, 'preferences');
    await settingsStore.setPreferences(payload.preferences);
    return { ok: true };
  });
  handle('personalization:addFeedback', async (payload) => {
    const id = String(payload.id ?? '');
    await settingsStore.addFeedback(id);
    return engineHost.controller.applyFeedback(id);
  });
  handle('personalization:reset', () => settingsStore.resetPersonalization());

  handle('ai:testProvider', (payload) => aiManager.testConnection(String(payload.provider ?? '')));
  handle('ai:listModels', (payload) => aiManager.listModels(String(payload.provider ?? '')));
  handle('ai:requestRecommendation', async () => {
    const t = engineHost.getTelemetry();
    const features = t?.features ?? engineHost.engine.features.latest;
    const pers = await settingsStore.getPersonalization();
    return aiManager.recommend(features, pers.preferences, engineHost.controller.mode, { force: true });
  });
  handle('ai:status', async () => ({ ok: true, status: aiManager.getStatus() }));

  return { broadcast };
}
