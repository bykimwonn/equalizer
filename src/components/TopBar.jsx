import React from 'react';
import { useApp } from '../state.jsx';

export default function TopBar() {
  const { telemetry, settings, invoke, engineStatus } = useApp();
  const mode = telemetry.mode ?? settings?.mode ?? 'adaptive';
  const aiState = telemetry.status?.backend ? 'live' : 'idle';

  const setMode = (m) => invoke('engine:setMode', { mode: m });

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="device-label">Output</span>
        <span className="device-name">
          {engineStatus.device === 'default' || !engineStatus.device
            ? 'Default output device'
            : engineStatus.device}
        </span>
        <span className={`pill ${engineStatus.state}`}>
          <span className="dot" />
          {engineStatus.backend === 'simulation'
            ? 'Simulation — no real audio I/O'
            : `engine ${engineStatus.state}`}
        </span>
      </div>
      <div className="topbar-right">
        <div className="mode-switch" role="group" aria-label="Processing mode">
          {['adaptive', 'hybrid', 'manual'].map((m) => (
            <button
              key={m}
              className={`mode-btn ${mode === m ? 'active' : ''}`}
              onClick={() => setMode(m)}
              title={
                m === 'adaptive'
                  ? 'AI adjusts processing automatically within safe bounds'
                  : m === 'hybrid'
                    ? 'AI proposes changes; you approve each one'
                    : 'Full manual control; AI is idle'
              }
            >
              {m === 'adaptive' ? 'Adaptive AI' : m === 'hybrid' ? 'Hybrid' : 'Manual'}
            </button>
          ))}
        </div>
        <span className={`pill ai ${aiState}`}>AI</span>
        <button className="icon-btn" title="Settings" onClick={() => window.dispatchEvent(new CustomEvent('bt:navigate', { detail: 'settings' }))}>
          ⚙
        </button>
      </div>
    </header>
  );
}
