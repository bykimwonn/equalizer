/**
 * Application state bridge to the Electron main process.
 * All real engine data flows here — there is no mock layer.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const Ctx = createContext(null);

export function useApp() {
  return useContext(Ctx);
}

const emptyTelemetry = {
  engine: { sampleRate: 48000, blockFrames: 256, blocksProcessed: 0, avgProcessMsPerBlock: 0, blockLatencyMs: 0, clipEvents: 0, underruns: 0 },
  input: { peak: 0, rmsDb: -160 },
  output: { peak: 0, rmsDb: -160 },
  features: { rmsDb: -160, peakDb: -160, bandEnergiesDb: Array(8).fill(-160), spectralCentroidHz: 0, loudnessLufs: -70, clipCount: 0 },
  spectrum: Array(64).fill(0),
  limiter: { clamps: 0, gainReductionDb: 0 },
  mode: 'adaptive',
  status: { state: 'stopped', backend: null, backendDetail: '' },
  pendingSuggestion: null
};

export function AppProvider({ children }) {
  const [booted, setBooted] = useState(false);
  const [appInfo, setAppInfo] = useState(null);
  const [settings, setSettings] = useState(null);
  const [dsp, setDsp] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [personalization, setPersonalization] = useState(null);
  const [backends, setBackends] = useState(null);
  const [engineStatus, setEngineStatus] = useState({ state: 'stopped', backend: null, backendDetail: '' });
  const [telemetry, setTelemetry] = useState(emptyTelemetry);
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState(null);
  const lastTeleUpdate = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const st = await window.bt.invoke('app:getState');
      if (!st?.ok) throw new Error(st?.error || 'failed to load app state');
      setAppInfo(st.app);
      setSettings(st.settings);
      setDsp(st.dsp);
      setCredentials(st.credentials);
      setPersonalization(st.personalization);
      setBackends(st.backends);
      setEngineStatus(st.engineStatus ?? { state: 'stopped' });
      setError(null);
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setBooted(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const offs = [
      window.bt.on('engine:telemetry', (t) => {
        // throttle React updates to ~20 Hz
        const now = performance.now();
        if (now - lastTeleUpdate.current > 50) {
          lastTeleUpdate.current = now;
          setTelemetry(t);
        }
      }),
      window.bt.on('engine:status', (s) => setEngineStatus(s)),
      window.bt.on('ai:suggestion', (s) => setSuggestion(s)),
      window.bt.on('settings:changed', (s) => {
        if (s?.settings) setDsp(s.settings);
      })
    ];
    return () => offs.forEach((off) => off && off());
  }, [refresh]);

  const invoke = useCallback(async (channel, payload) => {
    try {
      return await window.bt.invoke(channel, payload);
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  }, []);

  /** Push updated DSP settings to the engine (full object). */
  const applyDsp = useCallback(
    (nextOrFn) => {
      setDsp((cur) => {
        const next = typeof nextOrFn === 'function' ? nextOrFn(structuredClone(cur)) : nextOrFn;
        invoke('engine:setSettings', { settings: next });
        return next;
      });
    },
    [invoke]
  );

  const value = useMemo(
    () => ({
      booted,
      appInfo,
      settings,
      setSettings,
      dsp,
      applyDsp,
      credentials,
      setCredentials,
      personalization,
      setPersonalization,
      backends,
      engineStatus,
      telemetry,
      suggestion,
      setSuggestion,
      error,
      invoke,
      refresh
    }),
    [booted, appInfo, settings, dsp, applyDsp, credentials, personalization, backends, engineStatus, telemetry, suggestion, error, invoke, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
