import React from 'react';
import { useApp } from '../state.jsx';
import Spectrum, { Meters } from '../components/Spectrum.jsx';
import { Panel, Slider, Toggle, Button } from '../components/Controls.jsx';

export default function Overview() {
  const { telemetry, dsp, applyDsp, settings, invoke, engineStatus, backends } = useApp();
  if (!dsp) return null;

  const processingOn = !dsp.bypass;
  const f = telemetry.features ?? {};
  const quickProfiles = ['balanced', 'bass-boost', 'vocal-clarity', 'night', 'movie', 'gaming'];

  const toggleProcessing = (on) => invoke('engine:setBypass', { bypass: !on });
  const set = (path, value) =>
    applyDsp((d) => {
      const parts = path.split('.');
      let o = d;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      o[parts[parts.length - 1]] = value;
      return d;
    });

  const loadProfile = async (id) => {
    const res = await invoke('profiles:listAll');
    const all = [...(res.builtin ?? []), ...(res.custom ?? [])];
    const p = all.find((x) => x.id === id);
    if (p) {
      applyDsp(structuredClone(p.settings));
      invoke('settings:set', { patch: { activeProfileId: id } });
    }
  };

  return (
    <div className="grid">
      {engineStatus.duplication && engineStatus.state === 'running' && (
        <div className="banner warn span-2" role="alert">
          <strong>Heads up — you are hearing two copies of the audio.</strong>{' '}
          {engineStatus.duplication.message}
        </div>
      )}
      <Panel
        title="Master Processing"
        sub={engineStatus.backend === 'simulation'
          ? 'Simulation backend — generated test signal, no real audio I/O'
          : engineStatus.duplication
            ? 'Enhanced path active — the original audio also plays on the device (see warning above)'
            : 'Enhanced audio path active on the selected output'}
        className="span-2 master"
        right={
          <div className="master-actions">
            <Button variant="ghost" onClick={() => invoke('engine:undo')}>Undo</Button>
            <Button variant="ghost" onClick={() => invoke('engine:resetNeutral')}>Reset</Button>
          </div>
        }
      >
        <div className="master-row">
          <button
            className={`master-toggle ${processingOn ? 'on' : ''}`}
            onClick={() => toggleProcessing(!processingOn)}
          >
            <span className="master-dot" />
            {processingOn ? 'Processing ON' : 'Bypassed'}
          </button>
          <div className="master-meta">
            <div>
              <span className="meta-label">Mode</span>
              <span className="meta-value">{telemetry.mode ?? settings?.mode}</span>
            </div>
            <div>
              <span className="meta-label">Latency (block)</span>
              <span className="meta-value">{telemetry.engine.blockLatencyMs?.toFixed(1)} ms</span>
            </div>
            <div>
              <span className="meta-label">DSP cost</span>
              <span className="meta-value">{telemetry.engine.avgProcessMsPerBlock?.toFixed(2)} ms/block</span>
            </div>
            <div>
              <span className="meta-label">Loudness</span>
              <span className="meta-value">{(f.loudnessLufs ?? -70).toFixed(1)} LUFS</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Live Spectrum" sub="FFT of the processed signal (log bands, 20 Hz – 20 kHz)" className="span-2">
        <Spectrum telemetry={telemetry} />
        <Meters telemetry={telemetry} />
      </Panel>

      <Panel title="Tone Controls" sub="Bass enhancement & clarity (live DSP parameters)">
        <Slider
          label="Bass"
          value={dsp.bass.gainDb}
          min={-12}
          max={12}
          unit=" dB"
          onChange={(v) => set('bass.gainDb', v)}
        />
        <Slider
          label="Sub-bass"
          value={dsp.bass.subGainDb}
          min={-12}
          max={12}
          unit=" dB"
          onChange={(v) => set('bass.subGainDb', v)}
        />
        <Slider
          label="Harmonics"
          value={dsp.bass.harmonics}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => set('bass.harmonics', v)}
        />
        <Slider
          label="Clarity"
          value={dsp.clarity.presenceDb}
          min={-12}
          max={12}
          unit=" dB"
          onChange={(v) => set('clarity.presenceDb', v)}
        />
        <Slider
          label="Air"
          value={dsp.clarity.airDb}
          min={-12}
          max={12}
          unit=" dB"
          onChange={(v) => set('clarity.airDb', v)}
        />
        <Slider
          label="Output"
          value={dsp.outputGainDb}
          min={-24}
          max={24}
          unit=" dB"
          onChange={(v) => set('outputGainDb', v)}
        />
        <Toggle
          label="Bass protection"
          checked={dsp.bass.protection}
          onChange={(v) => set('bass.protection', v)}
          hint="Soft-limits generated harmonics to prevent distortion"
        />
        <Toggle
          label="Loudness normalization"
          checked={dsp.loudness.normalization}
          onChange={(v) => set('loudness.normalization', v)}
          hint="Slow, bounded loudness trim toward the target (optional)"
        />
      </Panel>

      <Panel title="Processing Summary" sub="What the engine is doing right now">
        <ul className="summary-list">
          <li>
            <span>Parametric EQ</span>
            <b>
              {dsp.eq.enabled
                ? `${dsp.eq.bands.filter((b) => Math.abs(b.gainDb) > 0.05 && b.enabled).length} bands active`
                : 'off'}
            </b>
          </li>
          <li>
            <span>Bass enhancer</span>
            <b>
              {dsp.bass.enabled
                ? `${dsp.bass.gainDb > 0 ? '+' : ''}${dsp.bass.gainDb} dB, harm ${(dsp.bass.harmonics * 100) | 0}%`
                : 'off'}
            </b>
          </li>
          <li>
            <span>Compressor</span>
            <b>
              {dsp.compressor.enabled
                ? `${dsp.compressor.ratio}:1 @ ${dsp.compressor.thresholdDb} dB${dsp.compressor.multiband ? ' (2-band)' : ''}`
                : 'off'}
            </b>
          </li>
          <li>
            <span>Limiter ceiling</span>
            <b>{dsp.limiter.enabled ? `${dsp.limiter.ceilingDb} dBFS` : 'off'}</b>
          </li>
          <li>
            <span>Stereo width</span>
            <b>{dsp.stereo.mono ? 'mono' : `${dsp.stereo.width.toFixed(2)}×`}</b>
          </li>
          <li>
            <span>Limiter events</span>
            <b>{telemetry.limiter?.clamps ?? 0} clamps prevented</b>
          </li>
          <li>
            <span>Clipping detected</span>
            <b className={f.clipCount > 0 ? 'warn' : ''}>{f.clipCount ?? 0} samples</b>
          </li>
        </ul>
      </Panel>

      <Panel title="Quick Profiles" sub="Applies real DSP settings instantly">
        <div className="quick-profiles">
          {quickProfiles.map((id) => (
            <button key={id} className="quick-profile" onClick={() => loadProfile(id)}>
              {id.replace('-', ' ')}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Audio Engine" sub="Measured engine health — not simulated numbers">
        <ul className="summary-list">
          <li>
            <span>Backend</span>
            <b>{backends ? Object.values(backends).find((b) => b.id === engineStatus.backend)?.label ?? '—' : '—'}</b>
          </li>
          <li>
            <span>Sample rate</span>
            <b>{telemetry.engine.sampleRate} Hz</b>
          </li>
          <li>
            <span>Block size</span>
            <b>{telemetry.engine.blockFrames} frames</b>
          </li>
          <li>
            <span>Blocks processed</span>
            <b>{telemetry.engine.blocksProcessed}</b>
          </li>
          <li>
            <span>Underruns</span>
            <b>{telemetry.engine.underruns}</b>
          </li>
          <li>
            <span>NaN guard</span>
            <b>{telemetry.engine.nanGuardTrips} trips</b>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
