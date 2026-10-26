import React, { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { Panel, Slider, Toggle, Button, Select, StatusPill } from '../components/Controls.jsx';

export default function AiStudio() {
  const { telemetry, personalization, invoke, settings, setSettings, suggestion, setSuggestion, refresh } = useApp();
  const [aiStatus, setAiStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const f = telemetry.features ?? {};

  useEffect(() => {
    invoke('ai:status').then((r) => r.ok && setAiStatus(r.status));
  }, [invoke]);

  const request = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await invoke('ai:requestRecommendation');
    setBusy(false);
    if (res.ok) {
      setResult(res);
      if (telemetry.mode === 'adaptive') {
        setResult({ ...res, note: 'Adaptive mode applied the validated proposal automatically.' });
      }
    } else {
      setError(res.throttled ? res.error : res.error || 'request failed');
    }
  };

  const feedback = async (id) => {
    await invoke('personalization:addFeedback', { id });
    refresh();
  };

  const prefs = personalization?.preferences ?? {};
  const setPref = (key, val) =>
    invoke('personalization:setPreferences', { preferences: { ...prefs, [key]: val } }).then(refresh);

  return (
    <div className="grid">
      <Panel
        title="AI Recommendation"
        sub="Compact feature summaries go to Groq/Gemini — raw audio never leaves your PC"
        className="span-2"
        right={<Button variant="primary" onClick={request} disabled={busy}>{busy ? 'Requesting…' : 'Request recommendation'}</Button>}
      >
        {error && <div className="error-bar">{error}</div>}
        {result?.ok && (
          <div className="ai-result">
            <div className="ai-result-head">
              <StatusPill state="ok">{result.provider} · {result.latencyMs} ms</StatusPill>
              {result.proposal?.confidence != null && (
                <span className="confidence">confidence {(result.proposal.confidence * 100).toFixed(0)}%</span>
              )}
            </div>
            <p className="ai-explain">{result.proposal?.explanation || 'No explanation provided.'}</p>
            {result.proposal?.profileId && (
              <p className="ai-profile">Recommended profile: <b>{result.proposal.profileId}</b></p>
            )}
            {result.warnings?.length > 0 && (
              <ul className="warn-list">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <p className="muted">{result.note ?? (telemetry.mode === 'hybrid' ? 'Hybrid mode: changes are proposed only — review and apply below.' : 'Validated settings were applied with smoothing.')}</p>
            <div className="row-actions">
              {telemetry.mode === 'hybrid' && result.validated?.settings && (
                <Button variant="primary" onClick={async () => {
                  await invoke('engine:setSettings', { settings: result.validated.settings });
                  setResult({ ...result, note: 'Proposal applied.' });
                }}>
                  Apply proposal
                </Button>
              )}
              <Button onClick={() => setResult(null)}>Dismiss</Button>
              <Button onClick={() => invoke('engine:undo')}>Undo last change</Button>
            </div>
          </div>
        )}
        {!result && !error && (
          <p className="muted">
            The local rules-based controller always runs first and reacts instantly to measured audio.
            Cloud AI is consulted for higher-level recommendations at most once per configured interval,
            and every proposal is validated against strict DSP bounds before it can affect the engine.
          </p>
        )}
      </Panel>

      <Panel title="Pending Suggestion (Hybrid)" sub="Suggestions wait here for your approval">
        {telemetry.pendingSuggestion || suggestion ? (
          <div className="ai-result">
            <p className="ai-explain">
              {telemetry.pendingSuggestion?.explanation || suggestion?.suggestion?.explanation || 'Suggestion received'}
            </p>
            <p className="muted">source: {telemetry.pendingSuggestion?.source || suggestion?.suggestion?.source}</p>
            <div className="row-actions">
              <Button variant="primary" onClick={async () => {
                await invoke('engine:acceptSuggestion');
                setSuggestion(null);
              }}>Apply</Button>
              <Button onClick={async () => {
                await invoke('engine:rejectSuggestion');
                setSuggestion(null);
              }}>Reject</Button>
            </div>
          </div>
        ) : (
          <p className="muted">No pending suggestion.</p>
        )}
      </Panel>

      <Panel title="Live Sound Analysis" sub="Measured features from the local analyzer">
        <ul className="summary-list">
          <li><span>RMS level</span><b>{f.rmsDb?.toFixed(1)} dB</b></li>
          <li><span>Peak level</span><b>{f.peakDb?.toFixed(1)} dB</b></li>
          <li><span>Crest factor</span><b>{f.crestDb?.toFixed(1)} dB</b></li>
          <li><span>Loudness (est.)</span><b>{f.loudnessLufs?.toFixed(1)} LUFS</b></li>
          <li><span>Spectral centroid</span><b>{(f.spectralCentroidHz ?? 0).toFixed(0)} Hz</b></li>
          <li><span>Rolloff (85%)</span><b>{(f.rolloff85Hz ?? 0).toFixed(0)} Hz</b></li>
          <li><span>Spectral flux</span><b>{(f.spectralFlux ?? 0).toFixed(3)}</b></li>
          <li><span>Clipping</span><b>{f.clipCount ?? 0} samples</b></li>
        </ul>
        <div className="band-energies">
          {(f.bandEnergiesDb ?? []).map((db, i) => (
            <div key={i} className="band-energy">
              <div className="band-bar" style={{ height: `${Math.max(2, Math.min(100, (db + 60) * 1.6))}%` }} />
              <span>{['20-60', '60-120', '120-250', '250-500', '500-1k', '1-3k', '3-8k', '8-20k'][i]}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Listening Preferences" sub="Stored locally — used to shape recommendations">
        <Toggle label="Stronger bass" checked={!!prefs.strongerBass} onChange={(v) => setPref('strongerBass', v)} />
        <Toggle label="Clearer vocals" checked={!!prefs.clearerVocals} onChange={(v) => setPref('clearerVocals', v)} />
        <Toggle label="Less harsh treble" checked={!!prefs.lessHarshTreble} onChange={(v) => setPref('lessHarshTreble', v)} />
        <Toggle label="More detail" checked={!!prefs.moreDetail} onChange={(v) => setPref('moreDetail', v)} />
        <Toggle label="Natural sound" checked={!!prefs.naturalSound} onChange={(v) => setPref('naturalSound', v)} />
        <Toggle label="Wider stereo image" checked={!!prefs.widerStereo} onChange={(v) => setPref('widerStereo', v)} />
        <Toggle label="Softer at night" checked={!!prefs.softerAtNight} onChange={(v) => setPref('softerAtNight', v)} />
        <Toggle label="Minimal compression" checked={!!prefs.minimalCompression} onChange={(v) => setPref('minimalCompression', v)} />
        <Toggle label="Clarity at low volume" checked={!!prefs.clarityAtLowVolume} onChange={(v) => setPref('clarityAtLowVolume', v)} />
      </Panel>

      <Panel title="Quick Feedback" sub="Tunes future recommendations (local learning)">
        <div className="feedback-grid">
          <Button onClick={() => feedback('better')}>👍 Better</Button>
          <Button onClick={() => feedback('too-much-bass')}>Too much bass</Button>
          <Button onClick={() => feedback('too-sharp')}>Too sharp</Button>
          <Button onClick={() => feedback('too-loud')}>Too loud</Button>
          <Button onClick={() => feedback('less-processing')}>Less processing</Button>
          <Button onClick={() => feedback('more-natural')}>More natural</Button>
          <Button variant="danger" onClick={() => feedback('reset-neutral')}>Reset to neutral</Button>
        </div>
      </Panel>

      <Panel title="Provider Status" sub="Genuine request state from the main process">
        <ul className="summary-list">
          <li><span>Selected provider</span><b>{settings?.ai?.provider}</b></li>
          <li><span>Groq</span><b>{aiStatus?.groq?.lastError ? `error: ${aiStatus.groq.lastError.slice(0, 40)}` : aiStatus?.groq?.lastOkAt ? `ok · ${aiStatus.groq.lastLatencyMs} ms` : aiStatus?.groq?.configured ? 'configured' : 'not configured'}</b></li>
          <li><span>Gemini</span><b>{aiStatus?.gemini?.lastError ? `error: ${aiStatus.gemini.lastError.slice(0, 40)}` : aiStatus?.gemini?.lastOkAt ? `ok · ${aiStatus.gemini.lastLatencyMs} ms` : aiStatus?.gemini?.configured ? 'configured' : 'not configured'}</b></li>
          <li><span>Last used</span><b>{aiStatus?.lastProviderUsed ?? '—'}</b></li>
        </ul>
        <p className="muted">The app stays fully usable without API keys: profiles, manual EQ, and the local adaptive rules all work offline.</p>
      </Panel>
    </div>
  );
}
