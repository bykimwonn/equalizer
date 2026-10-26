import React, { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { Panel, Button } from '../components/Controls.jsx';

export default function Profiles() {
  const { invoke, applyDsp, settings, setSettings, refresh } = useApp();
  const [all, setAll] = useState({ builtin: [], custom: [] });
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const res = await invoke('profiles:listAll');
    if (res.ok) setAll(res);
  };
  useEffect(() => {
    load();
  }, []);

  const activate = async (p) => {
    applyDsp(structuredClone(p.settings));
    await invoke('settings:set', { patch: { activeProfileId: p.id } });
    setSettings((s) => ({ ...s, activeProfileId: p.id }));
    setMsg(`Applied “${p.name}”`);
  };

  const saveCustom = async () => {
    const name = window.prompt('Profile name:', 'My Profile');
    if (!name) return;
    const cur = await invoke('app:getState');
    const saved = await invoke('profiles:saveCustom', {
      profile: { name, description: 'Custom profile', settings: cur.dsp }
    });
    if (saved?.id) setMsg(`Saved “${name}”`);
    else setMsg(`Save failed: ${saved?.error || 'unknown error'}`);
    load();
    refresh();
  };

  const duplicate = async (p) => {
    await invoke('profiles:saveCustom', {
      profile: { name: `${p.name} copy`, description: p.description, settings: structuredClone(p.settings) }
    });
    setMsg('Profile duplicated');
    load();
  };

  const rename = async (p) => {
    const name = window.prompt('New name:', p.name);
    if (!name) return;
    await invoke('profiles:saveCustom', {
      profile: { id: p.id, name, description: p.description, settings: p.settings }
    });
    load();
  };

  const remove = async (p) => {
    await invoke('profiles:deleteCustom', { id: p.id });
    load();
  };

  const exportProfile = async (p) => {
    const data = await invoke('profiles:export', { id: p.id });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.id}.btp.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importProfile = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await invoke('profiles:import', { profile: JSON.parse(text) });
        if (res.id) setMsg(`Imported “${res.name}”`);
        else setMsg(`Import failed: ${res.error}`);
      } catch (e) {
        setMsg(`Import failed: ${e.message}`);
      }
      load();
    };
    input.click();
  };

  const card = (p, custom) => (
    <div key={p.id} className={`profile-card ${settings?.activeProfileId === p.id ? 'active' : ''}`}>
      <div className="profile-head">
        <h4>{p.name}</h4>
        {settings?.activeProfileId === p.id && <span className="pill ok"><span className="dot" />active</span>}
      </div>
      <p>{p.description}</p>
      <div className="profile-actions">
        <Button variant="primary" onClick={() => activate(p)}>Apply</Button>
        <Button onClick={() => duplicate(p)}>Duplicate</Button>
        {custom && <Button onClick={() => rename(p)}>Rename</Button>}
        <Button onClick={() => exportProfile(p)}>Export</Button>
        {custom && <Button variant="danger" onClick={() => remove(p)}>Delete</Button>}
      </div>
    </div>
  );

  return (
    <div className="grid">
      <Panel
        title="Sound Profiles"
        sub="Every profile maps to concrete DSP settings — apply, customize, or build your own"
        className="span-2"
        right={
          <div className="master-actions">
            <Button variant="primary" onClick={saveCustom}>Save current as custom</Button>
            <Button onClick={importProfile}>Import</Button>
          </div>
        }
      >
        {msg && <div className="info-bar">{msg}</div>}
        <h4 className="group-title">Built-in</h4>
        <div className="profile-grid">{all.builtin.map((p) => card(p, false))}</div>
        <h4 className="group-title">Custom</h4>
        <div className="profile-grid">
          {all.custom.length === 0 ? (
            <p className="muted">No custom profiles yet — dial in a sound you like and save it here.</p>
          ) : (
            all.custom.map((p) => card(p, true))
          )}
        </div>
      </Panel>
    </div>
  );
}
