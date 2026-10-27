import React, { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { Panel, Button, Select, StatusPill } from '../components/Controls.jsx';

export default function Devices() {
  const { invoke, engineStatus, backends, settings, setSettings, telemetry, refresh } = useApp();
  const [devInfo, setDevInfo] = useState(null);
  const [diag, setDiag] = useState(null);

  const load = async () => {
    setDevInfo(await invoke('devices:enumerate'));
    const d = await invoke('engine:diagnostics');
    if (d.ok) setDiag(d.diagnostics);
  };
  useEffect(() => {
    load();
  }, []);

  const saveAudio = async (patch) => {
    await invoke('settings:set', { patch: { audio: patch } });
    setSettings((s) => ({ ...s, audio: { ...s.audio, ...patch } }));
    refresh();
  };

  const restart = async () => {
    await invoke('engine:stop');
    await invoke('engine:start');
    load();
  };

  const routingExplain = {
    'process-loopback':
      'WASAPI process loopback capture (Windows 10 build 20348+) of the system audio stream with the BT process tree excluded, processed locally, rendered to the selected output. No feedback loop because our own render is excluded from the capture. This is the default enhanced path.',
    'loopback-to-cable':
      'Classic WASAPI endpoint loopback capture, processed locally, rendered to a virtual audio cable (e.g. VB-CABLE). Set the cable as the default Windows playback device to enhance all system audio through it. Requires a virtual cable driver to be installed.',
    apo:
      'Windows Audio Processing Object (APO) loaded into the Windows audio engine (audiodg.exe) on the output endpoint — the Equalizer-APO-style system-wide path. Requires registration (admin) and, for unsigned builds, test signing or DisableProtectedAudioDG. See docs/INSTALL-WINDOWS.md.'
  };

  return (
    <div className="grid">
      <Panel
        title="Audio Routing"
        sub="How captured audio is enhanced and delivered to your output device"
        className="span-2"
        right={<Button onClick={restart}>Restart engine</Button>}
      >
        <div className="routing-options">
          {Object.entries(routingExplain).map(([id, text]) => (
            <div
              key={id}
              className={`routing-card ${settings?.audio?.routingMode === id ? 'active' : ''}`}
              onClick={() => saveAudio({ routingMode: id })}
            >
              <div className="routing-head">
                <b>{id === 'process-loopback' ? 'Enhanced Path (recommended)' : id === 'loopback-to-cable' ? 'Virtual Cable Routing' : 'System-wide APO'}</b>
                {settings?.audio?.routingMode === id && <StatusPill state="ok">selected</StatusPill>}
              </div>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <p className="muted">
          BT AI Equalizer never silently changes your default playback device or system settings —
          any routing change that requires it is done by you, explicitly.
        </p>
      </Panel>

      <Panel title="Devices" sub={devInfo?.backendDetail ?? ''}>
        <Select
          label="Backend"
          value={settings?.audio?.backend ?? 'wasapi'}
          options={[
            { value: 'wasapi', label: 'WASAPI (native, real audio)' },
            { value: 'simulation', label: 'Simulation (development only)' }
          ]}
          onChange={async (v) => {
            await saveAudio({ backend: v });
            await invoke('engine:stop');
            await invoke('engine:start');
          }}
        />
        <Select
          label="Capture source"
          value={settings?.audio?.captureDeviceId ?? 'default'}
          options={[
            { value: 'default', label: 'Default / system loopback' },
            ...(devInfo?.devices ?? [])
              .filter((d) => d.isCapture || d.loopbackSupported)
              .map((d) => ({ value: d.id, label: d.name }))
          ]}
          onChange={(v) => saveAudio({ captureDeviceId: v })}
        />
        <Select
          label="Render (output) device"
          value={settings?.audio?.renderDeviceId ?? 'default'}
          options={[
            { value: 'default', label: 'Default output' },
            ...(devInfo?.devices ?? [])
              .filter((d) => d.isRender)
              .map((d) => ({ value: d.id, label: d.name }))
          ]}
          onChange={(v) => saveAudio({ renderDeviceId: v })}
        />
        <div className="device-table">
          {(devInfo?.devices ?? []).map((d) => (
            <div key={d.id} className="device-row">
              <div>
                <b>{d.name}</b>
                <span className="muted">
                  {d.isRender ? 'output' : 'input'}
                  {d.isDefault ? ' · default' : ''}
                  {d.sampleRates ? ` · ${d.sampleRates.join('/')} Hz` : ''}
                  {d.channels ? ` · ${d.channels} ch` : ''}
                  {d.note ? ` · ${d.note}` : ''}
                </span>
              </div>
              <StatusPill state={d.isDefault ? 'ok' : 'idle'}>{d.isDefault ? 'default' : 'available'}</StatusPill>
            </div>
          ))}
          {(!devInfo?.devices || devInfo.devices.length === 0) && (
            <p className="muted">
              {devInfo?.backendAvailable === false
                ? `Device enumeration unavailable: ${devInfo.backendDetail}`
                : 'No devices reported.'}
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Engine Health" sub="Real measured state">
        <ul className="summary-list">
          <li><span>State</span><b>{engineStatus.state}</b></li>
          <li><span>Backend</span><b>{engineStatus.backend ?? '—'}</b></li>
          <li><span>Routing</span><b>{engineStatus.routingMode ?? '—'}</b></li>
          <li><span>Blocks processed</span><b>{telemetry.engine.blocksProcessed}</b></li>
          <li><span>Avg DSP cost</span><b>{telemetry.engine.avgProcessMsPerBlock?.toFixed(2)} ms</b></li>
          <li><span>Block latency</span><b>{telemetry.engine.blockLatencyMs?.toFixed(1)} ms</b></li>
          <li><span>Auto-restarts</span><b>{engineStatus.restarts ?? 0}</b></li>
          {engineStatus.lastError && (
            <li><span>Last error</span><b className="warn">{engineStatus.lastError}</b></li>
          )}
        </ul>
        <h4 className="group-title">Available backends</h4>
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
    </div>
  );
}
