import React, { useEffect, useState } from 'react';
import { AppProvider, useApp } from './state.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import Overview from './screens/Overview.jsx';
import EqualizerScreen from './screens/Equalizer.jsx';
import AiStudio from './screens/AiStudio.jsx';
import Profiles from './screens/Profiles.jsx';
import Devices from './screens/Devices.jsx';
import Personalization from './screens/Personalization.jsx';
import SettingsScreen from './screens/Settings.jsx';

const SCREENS = {
  overview: Overview,
  equalizer: EqualizerScreen,
  ai: AiStudio,
  profiles: Profiles,
  devices: Devices,
  personalization: Personalization,
  settings: SettingsScreen
};

function Shell() {
  const { booted, error } = useApp();
  const [screen, setScreen] = useState('overview');

  // top-bar settings gear (and any future deep link) navigates via this event
  useEffect(() => {
    const handler = (e) => {
      const target = e.detail;
      if (target && SCREENS[target]) setScreen(target);
    };
    window.addEventListener('bt:navigate', handler);
    return () => window.removeEventListener('bt:navigate', handler);
  }, []);

  if (!booted) {
    return (
      <div className="boot">
        <div className="boot-logo">BT</div>
        <div className="boot-text">Starting audio engine…</div>
      </div>
    );
  }

  const Screen = SCREENS[screen] ?? Overview;

  return (
    <div className="app">
      <Sidebar screen={screen} onNavigate={setScreen} />
      <div className="main">
        <TopBar />
        {error && <div className="error-bar">State error: {error}</div>}
        <div className="screen">
          <Screen />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
