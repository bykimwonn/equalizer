import React, { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { Panel, Toggle, Button } from '../components/Controls.jsx';

export default function Personalization() {
  const { invoke, personalization, refresh, setPersonalization } = useApp();
  const [diag, setDiag] = useState(null);

  useEffect(() => {
    invoke('engine:diagnostics').then((r) => r.ok && setDiag(r.diagnostics));
  }, [invoke]);

  const prefs = personalization?.preferences ?? {};
  const setPref = (key, val) =>
    invoke('personalization:setPreferences', { preferences: { ...prefs, [key]: val } }).then(refresh);

  const feedback = (id) => invoke('personalization:addFeedback', { id }).then(() => {
    refresh();
    invoke('engine:diagnostics').then((r) => r.ok && setDiag(r.diagnostics));
  });

  const reset = async () => {
    if (!window.confirm('Delete all saved listening preferences and feedback history?')) return;
    await invoke('personalization:reset');
    setPersonalization({ preferences: {}, feedback: [], learnedAdjustments: null });
    refresh();
  };

  return (
    <div className="grid">
      <Panel
        title="Listening Preferences"
        sub="Stored locally on this PC. Never uploaded by default."
        className="span-2"
        right={<Button variant="danger" onClick={reset}>Reset personalization</Button>}
      >
        <div className="pref-grid">
          <Toggle label="Stronger bass" checked={!!prefs.strongerBass} onChange={(v) => setPref('strongerBass', v)} hint="Preference for enhanced low end" />
          <Toggle label="Clearer vocals" checked={!!prefs.clearerVocals} onChange={(v) => setPref('clearerVocals', v)} hint="Prioritize speech intelligibility" />
          <Toggle label="Less harsh treble" checked={!!prefs.lessHarshTreble} onChange={(v) => setPref('lessHarshTreble', v)} hint="Tame sharp high frequencies" />
          <Toggle label="More detail" checked={!!prefs.moreDetail} onChange={(v) => setPref('moreDetail', v)} hint="Subtle presence/air emphasis" />
          <Toggle label="Natural sound" checked={!!prefs.naturalSound} onChange={(v) => setPref('naturalSound', v)} hint="Minimal coloration" />
          <Toggle label="Wider stereo image" checked={!!prefs.widerStereo} onChange={(v) => setPref('widerStereo', v)} hint="Mid/side width expansion" />
          <Toggle label="Softer at night" checked={!!prefs.softerAtNight} onChange={(v) => setPref('softerAtNight', v)} hint="Comfortable late-night levels" />
          <Toggle label="Minimal compression" checked={!!prefs.minimalCompression} onChange={(v) => setPref('minimalCompression', v)} hint="Preserve dynamic range" />
          <Toggle label="Clarity at low volume" checked={!!prefs.clarityAtLowVolume} onChange={(v) => setPref('clarityAtLowVolume', v)} hint="Presence lift when quiet" />
        </div>
      </Panel>

      <Panel title="Feedback" sub="Each action adjusts future recommendations and can alter current settings immediately">
        <div className="feedback-grid">
          <Button variant="primary" onClick={() => feedback('better')}>👍 Better</Button>
          <Button onClick={() => feedback('too-much-bass')}>Too much bass</Button>
          <Button onClick={() => feedback('too-sharp')}>Too sharp</Button>
          <Button onClick={() => feedback('too-loud')}>Too loud</Button>
          <Button onClick={() => feedback('less-processing')}>Less processing</Button>
          <Button onClick={() => feedback('more-natural')}>More natural</Button>
          <Button variant="danger" onClick={() => feedback('reset-neutral')}>Reset to neutral</Button>
        </div>
      </Panel>

      <Panel title="Feedback History" sub="Stored locally — used only for local personalization">
        <ul className="history-list">
          {(personalization?.feedback ?? [])
            .slice()
            .reverse()
            .slice(0, 25)
            .map((f, i) => (
              <li key={i}>
                <span>{f.id}</span>
                <span className="muted">{new Date(f.at).toLocaleTimeString()}</span>
              </li>
            ))}
          {(personalization?.feedback ?? []).length === 0 && <li className="muted">No feedback recorded yet.</li>}
        </ul>
      </Panel>

      <Panel title="Adaptive Controller Log" sub="What the local rules engine has done (most recent first)">
        <ul className="history-list">
          {(diag?.controller?.history ?? [])
            .slice()
            .reverse()
            .map((h, i) => (
              <li key={i}>
                <span>{h.source}</span>
                <span className="muted">{h.summary}</span>
              </li>
            ))}
          {(diag?.controller?.history ?? []).length === 0 && <li className="muted">No controller actions yet.</li>}
        </ul>
        <p className="muted">Safety actions taken: {diag?.controller?.safetyActions ?? 0}</p>
      </Panel>

      <Panel title="Privacy" sub="What leaves your computer">
        <ul className="summary-list">
          <li><span>Raw audio uploaded</span><b>never</b></li>
          <li><span>Feature summaries to AI</span><b>only when you allow AI and a request is due</b></li>
          <li><span>Preferences storage</span><b>local files in your user profile</b></li>
          <li><span>Telemetry/crash reporting</span><b>none — no analytics in this build</b></li>
        </ul>
      </Panel>
    </div>
  );
}
