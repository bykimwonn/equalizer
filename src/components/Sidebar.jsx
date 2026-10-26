import React from 'react';
import { useApp } from '../state.jsx';

const NAV = [
  ['overview', 'Overview', '◧'],
  ['equalizer', 'Equalizer', '≋'],
  ['ai', 'AI Sound Studio', '✦'],
  ['profiles', 'Sound Profiles', '◎'],
  ['devices', 'Audio Devices', '⇄'],
  ['personalization', 'Personalization', '◐'],
  ['settings', 'Settings', '⚙']
];

export default function Sidebar({ screen, onNavigate }) {
  const { engineStatus } = useApp();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">BT</div>
        <div className="brand-name">
          AI Equalizer
          <span className="brand-sub">Real-time audio engine</span>
        </div>
      </div>
      <nav>
        {NAV.map(([id, label, icon]) => (
          <button
            key={id}
            className={`nav-item ${screen === id ? 'active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <span className="nav-icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className={`engine-badge ${engineStatus.state}`}>
          <span className="dot" />
          engine: {engineStatus.state}
        </div>
      </div>
    </aside>
  );
}
