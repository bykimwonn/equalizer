/**
 * Preload bridge — contextIsolation + strict channel allowlist.
 * The renderer never sees ipcRenderer directly; unknown channels throw.
 * (CommonJS on purpose: keeps sandbox compatibility.)
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
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

const PUSH_CHANNELS = new Set([
  'engine:telemetry',
  'engine:status',
  'ai:suggestion',
  'settings:changed'
]);

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function on(channel, callback) {
  if (!PUSH_CHANNELS.has(channel)) {
    throw new Error(`IPC push channel not allowed: ${channel}`);
  }
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bt', {
  invoke,
  on,
  channels: Object.freeze({
    invoke: [...INVOKE_CHANNELS],
    push: [...PUSH_CHANNELS]
  })
});
