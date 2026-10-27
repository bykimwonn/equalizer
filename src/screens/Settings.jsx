import React, { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { Panel, Toggle, Select, Slider, Button, StatusPill } from '../components/Controls.jsx';

export default function SettingsScreen() {
  const { invoke, settings, setSettings, credentials, refresh, appInfo, backends } = useApp();
  const [keys, setKeys] = useState({ groq: '', gemini: '' });
  const [models, setModels] = useState({ groq: [], gemini: [] });
  const [testRes, setTestRes] = useState({});
  const [busy, setBusy] = useState(null);
  const [diag, setDiag] = useState(null);

  useEffect(() => {
    invoke('engine:diagnostics').then((r) => r.ok && setDiag(r.diagnostics));
  }, [invoke]);

  const savePatch = async (patch) => {
    await invoke('settings:set', { patch });
    setSettings((s) => ({ ...s, ...patch }));
    refresh();
  };

  const loadModels = async (provider) => {
    setBusy(provider);
    const res = await invoke('ai:listModels', { provider });
    setBusy(null);
    if (res.ok) setModels((m) => ({ ...m, [provider]: res.models }));
    else setTestRes((t) => ({ ...t, [provider]: { ok: false, error: res.error } }));
  };

  const testProvider = async (provider) => {
    setBusy(provider);
    const res = await invoke('ai:testProvider', { provider });
    setBusy(null);
    setTestRes((t) => ({ ...t, [provider]: res }));
    if (res.ok) loadModels(provider);
  };

  const saveKey = async (provider) => {
    const apiKey = keys[provider].trim();
    if (!apiKey) return;
    setBusy(provider);
    const res = await invoke('settings:setApiKey', { provider, apiKey });
    setBusy(null);
    setKeys((k) => ({ ...k, [provider]: '' }));
    setTestRes((t) => ({ ...t, [provider]: res.ok ? { ok: true, message: `key saved (${res.storage})` } : res }));
    refresh();
  };

  const clearKey = async (provider) => {
    await invoke('settings:clearApiKey', { provider });
    setModels((m) => ({ ...m, [provider]: [] }));
    refresh();
  };

  const ai = settings?.ai ?? {};
  const audio = settings?.audio ?? {};
  const ui = settings?.ui ?? {};

  return (
    <div className="grid">
      <Panel title="AI Providers" sub="Keys are stored in the OS credential store — never in the renderer, logs, or source control" className="span-2">
        <div className="provider-grid">
          {[
            ['groq', 'Groq', 'Fast profile recommendations and parameter proposals'],
            ['gemini', 'Google Gemini', 'Detailed analysis, comparison, guided calibration']
          ].map(([id, name, desc]) => (
            <div key={id} className="provider-card">
              <div className="provider-head">
                <h4>{name}</h4>
                <StatusPill state={credentials?.[id]?.configured ? 'ok' : 'idle'}>
                  {credentials?.[id]?.configured ? `configured · ${credentials[id].storage}` : 'not configured'}
                </StatusPill>
              </div>
              <p className="muted">{desc}</p>
              <div className="key-row">
                <input
                  type="password"
                  placeholder="Paste API key…"
                  value={keys[id]}
                  onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
                  autoComplete="off"
                />
                <Button variant="primary" onClick={() => saveKey(id)} disabled={!keys[id] || busy === id}>
                  Save key
                </Button>
                <Button onClick={() => testProvider(id)} disabled={busy === id}>
                  {busy === id ? 'Working…' : 'Test connection'}
                </Button>
                <Button variant="danger" onClick={() => clearKey(id)} disabled={!credentials?.[id]?.configured}>
                  Clear
                </Button>
              </div>
              {testRes[id] && (
                <p className={testRes[id].ok ? 'ok-text' : 'error-text'}>
                  {testRes[id].ok
                    ? `✓ ${testRes[id].message || `connected in ${testRes[id].latencyMs} ms — ${testRes[id].modelCount} models available`}`
                    : `✗ ${testRes[id].error}`}
                </p>
              )}
              {models[id].length > 0 && (
                <Select
                  label="Model"
                  value={ai[id]?.model ?? ''}
                  options={models[id].map((m) => ({ value: m.id, label: m.label || m.id }))}
                  onChange={(v) => savePatch({ ai: { [id]: { model: v } } })}
                />
              )}
              {models[id].length === 0 && ai[id]?.model && (
                <p className="muted">Model: {ai[id].model} — click “Test connection” to load the current live model list.</p>
              )}
            </div>
          ))}
        </div>

        <Select
          label="Preferred provider"
          value={ai.provider ?? 'auto'}
          options={[
            { value: 'auto', label: 'Automatic (Groq first, fallback to Gemini)' },
            { value: 'groq', label: 'Groq only' },
            { value: 'gemini', label: 'Google Gemini only' }
          ]}
          onChange={(v) => savePatch({ ai: { provider: v } })}
        />
        <Toggle
          label="Fallback to the other provider on failure"
          checked={ai.fallback !== false}
          onChange={(v) => savePatch({ ai: { fallback: v } })}
        />
        <Slider
          label="Minimum interval between AI requests"
          value={(ai.requestIntervalMs ?? 60000) / 1000}
          min={5}
          max={600}
          step={5}
          unit=" s"
          onChange={(v) => savePatch({ ai: { requestIntervalMs: v * 1000 } })}
        />
        <Toggle
          label="Only request when content changes meaningfully"
          checked={ai.onlyOnContentChange !== false}
          onChange={(v) => savePatch({ ai: { onlyOnContentChange: v } })}
        />
      </Panel>

      <Panel title="Audio Engine" sub="Buffer sizes and backend selection">
        <Select
          label="Backend"
          value={audio.backend ?? 'wasapi'}
          options={[
            { value: 'wasapi', label: 'WASAPI (native)' },
            { value: 'simulation', label: 'Simulation (development only)' }
          ]}
          onChange={(v) => savePatch({ audio: { backend: v } })}
        />
        <Select
          label="Processing block size"
          value={String(audio.blockFrames ?? 256)}
          options={[
            { value: '128', label: '128 frames (lowest latency)' },
            { value: '256', label: '256 frames (recommended)' },
            { value: '512', label: '512 frames (most robust)' },
            { value: '1024', label: '1024 frames' }
          ]}
          onChange={(v) => savePatch({ audio: { blockFrames: Number(v) } })}
        />
        <Select
          label="Sample rate"
          value={String(audio.sampleRate ?? 48000)}
          options={[
            { value: '44100', label: '44100 Hz' },
            { value: '48000', label: '48000 Hz (recommended)' },
            { value: '96000', label: '96000 Hz' }
          ]}
          onChange={(v) => savePatch({ audio: { sampleRate: Number(v) } })}
        />
        <p className="muted">Changes take effect on the next engine restart (Audio Devices → Restart engine).</p>
      </Panel>

      <Panel title="Desktop Integration" sub="Startup, tray and hotkeys">
        <Toggle
          label="Minimize to tray"
          checked={ui.minimizeToTray !== false}
          onChange={(v) => savePatch({ ui: { minimizeToTray: v } })}
        />
        <Toggle
          label="Start with Windows"
          checked={ui.startWithWindows === true}
          onChange={async (v) => {
            await savePatch({ ui: { startWithWindows: v } });
            const res = await invoke('app:setLoginItem', { enabled: v });
            if (!res.ok) setTestRes((t) => ({ ...t, loginItem: { ok: false, error: res.error } }));
          }}
          hint="Registers the app in the current user's startup items (no admin required)"
        />
        <div className="hotkey-list">
          <div><span>Toggle processing</span><kbd>Ctrl+Shift+E</kbd></div>
          <div><span>Cycle mode</span><kbd>Ctrl+Shift+M</kbd></div>
          <div><span>Next profile</span><kbd>Ctrl+Shift+P</kbd></div>
        </div>
      </Panel>

      <Panel title="Diagnostics" sub="Engine internals and version information">
        <ul className="summary-list">
          <li><span>App</span><b>{appInfo?.name} {appInfo?.version}</b></li>
          <li><span>Platform</span><b>{appInfo?.platform} · Electron {appInfo?.electron} · Node {appInfo?.node}</b></li>
          <li><span>Engine blocks</span><b>{diag?.engine?.blocksProcessed ?? 0}</b></li>
          <li><span>NaN guard trips</span><b>{diag?.engine?.nanGuardTrips ?? 0}</b></li>
          <li><span>Clip events</span><b>{diag?.engine?.clipEvents ?? 0}</b></li>
          <li><span>Controller safety actions</span><b>{diag?.controller?.safetyActions ?? 0}</b></li>
          <li><span>Driver/APO install</span><b className="warn">see docs/INSTALL-WINDOWS.md — not installed by this build</b></li>
        </ul>
        <h4 className="group-title">Backends</h4>
        <ul className="summary-list">
          {backends &&
            Object.values(backends).map((b) => (
              <li key={b.id}>
                <span>{b.label}</span>
                <b className={b.available ? '' : 'warn'}>{b.available ? 'ready' : b.detail}</b>
              </li>
            ))}
        </ul>
      </Panel>

      <Panel title="Privacy & Data" sub="Local-first by design">
        <ul className="summary-list">
          <li><span>API key storage</span><b>{credentials?.groq?.storage ?? credentials?.gemini?.storage ?? 'OS credential store / encrypted file'}</b></li>
          <li><span>Raw audio upload</span><b>disabled (not implemented — by design)</b></li>
          <li><span>Usage analytics</span><b>none</b></li>
        </ul>
        <Button
          variant="danger"
          onClick={async () => {
            if (!window.confirm('Delete personalization data? API keys are kept.')) return;
            await invoke('personalization:reset');
            refresh();
          }}
        >
          Delete personalization data
        </Button>
      </Panel>
    </div>
  );
}
