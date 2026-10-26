import React, { useState } from 'react';
import { useApp } from '../state.jsx';
import EqEditor from '../components/EqEditor.jsx';
import { Panel, Slider, Toggle, Select, Button } from '../components/Controls.jsx';

const FILTER_OPTIONS = [
  { value: 'peaking', label: 'Peaking (bell)' },
  { value: 'lowshelf', label: 'Low shelf' },
  { value: 'highshelf', label: 'High shelf' },
  { value: 'lowpass', label: 'Low pass' },
  { value: 'highpass', label: 'High pass' },
  { value: 'notch', label: 'Notch' },
  { value: 'bandpass', label: 'Band pass' }
];

export default function EqualizerScreen() {
  const { dsp, applyDsp, invoke, telemetry } = useApp();
  const [selected, setSelected] = useState(5);
  const [ab, setAb] = useState('a');
  const [stored, setStored] = useState(null);
  if (!dsp) return null;

  const bands = dsp.eq.bands;

  const updateBand = (idx, patch) =>
    applyDsp((d) => {
      Object.assign(d.eq.bands[idx], patch);
      return d;
    });

  const resetEq = () =>
    applyDsp((d) => {
      d.eq.bands.forEach((b) => {
        b.gainDb = 0;
        b.q = 1;
      });
      return d;
    });

  const toggleBypass = (on) => invoke('engine:setBypass', { bypass: !on });

  const abSwap = () => {
    if (ab === 'a') {
      setStored(structuredClone(dsp));
      if (stored) applyDsp(structuredClone(stored));
      setAb('b');
    } else {
      const cur = structuredClone(dsp);
      if (stored) applyDsp(structuredClone(stored));
      setStored(cur);
      setAb('a');
    }
  };

  const band = bands[selected] ?? bands[0];

  return (
    <div className="grid">
      <Panel
        title="Parametric Equalizer"
        sub="Curve computed from the live filter coefficients — drag to sculpt the response"
        className="span-2"
        right={
          <div className="master-actions">
            <Button onClick={abSwap} title="Swap between two settings sets">A/B: {ab.toUpperCase()}</Button>
            <Button onClick={() => toggleBypass(!dsp.bypass)}>
              {dsp.bypass ? 'Enable processing' : 'Bypass (A/B unprocessed)'}
            </Button>
            <Button variant="danger" onClick={resetEq}>Reset EQ</Button>
          </div>
        }
      >
        <EqEditor
          bands={bands}
          sampleRate={telemetry.engine.sampleRate || 48000}
          selected={selected}
          onSelect={setSelected}
          onChange={updateBand}
        />
      </Panel>

      <Panel title={`Band ${selected + 1} — ${Math.round(band.freq)} Hz`} sub="Filter type, Q and gain for the selected band">
        <Select
          label="Filter type"
          value={band.type}
          options={FILTER_OPTIONS}
          onChange={(v) => updateBand(selected, { type: v })}
        />
        <Slider
          label="Frequency"
          value={band.freq}
          min={20}
          max={20000}
          step={1}
          unit=" Hz"
          format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`)}
          onChange={(v) => updateBand(selected, { freq: v })}
        />
        <Slider
          label="Gain"
          value={band.gainDb}
          min={-15}
          max={15}
          unit=" dB"
          onChange={(v) => updateBand(selected, { gainDb: v })}
        />
        <Slider
          label="Q factor"
          value={band.q}
          min={0.1}
          max={10}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => updateBand(selected, { q: v })}
        />
        <Toggle
          label="Band enabled"
          checked={band.enabled}
          onChange={(v) => updateBand(selected, { enabled: v })}
        />
      </Panel>

      <Panel title="Graphic EQ (10-band)" sub="Classic graphic layout — same filters under the hood">
        <div className="graphic-eq">
          {bands.map((b, i) => (
            <div key={b.id} className="graphic-band">
              <input
                type="range"
                min={-15}
                max={15}
                step={0.5}
                value={b.gainDb}
                orient="vertical"
                onChange={(e) => updateBand(i, { gainDb: Number(e.target.value) })}
                onClick={() => setSelected(i)}
              />
              <span className="graphic-freq">{b.freq >= 1000 ? `${b.freq / 1000}k` : b.freq}</span>
              <span className="graphic-gain">{b.gainDb > 0 ? '+' : ''}{b.gainDb}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Dynamics" sub="Compressor and output protection">
        <Toggle
          label="Compressor enabled"
          checked={dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.enabled = v; return d; })}
        />
        <Slider
          label="Threshold"
          value={dsp.compressor.thresholdDb}
          min={-60}
          max={0}
          unit=" dB"
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.thresholdDb = v; return d; })}
        />
        <Slider
          label="Ratio"
          value={dsp.compressor.ratio}
          min={1}
          max={20}
          step={0.1}
          format={(v) => `${v.toFixed(1)}:1`}
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.ratio = v; return d; })}
        />
        <Slider
          label="Attack"
          value={dsp.compressor.attackMs}
          min={0.1}
          max={200}
          unit=" ms"
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.attackMs = v; return d; })}
        />
        <Slider
          label="Release"
          value={dsp.compressor.releaseMs}
          min={5}
          max={2000}
          unit=" ms"
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.releaseMs = v; return d; })}
        />
        <Slider
          label="Knee"
          value={dsp.compressor.kneeDb}
          min={0}
          max={24}
          unit=" dB"
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.kneeDb = v; return d; })}
        />
        <Slider
          label="Makeup"
          value={dsp.compressor.makeupDb}
          min={-12}
          max={12}
          unit=" dB"
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.makeupDb = v; return d; })}
        />
        <Toggle
          label="Multiband (2-band)"
          checked={dsp.compressor.multiband}
          disabled={!dsp.compressor.enabled}
          onChange={(v) => applyDsp((d) => { d.compressor.multiband = v; return d; })}
        />
      </Panel>

      <Panel title="Stereo & Output" sub="Image controls and final limiter">
        <Slider
          label="Stereo width"
          value={dsp.stereo.width}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => applyDsp((d) => { d.stereo.width = v; return d; })}
        />
        <Slider
          label="Balance"
          value={dsp.stereo.balance}
          min={-1}
          max={1}
          step={0.01}
          format={(v) => (v === 0 ? 'center' : `${v < 0 ? 'L' : 'R'} ${Math.abs(v * 100) | 0}%`)}
          onChange={(v) => applyDsp((d) => { d.stereo.balance = v; return d; })}
        />
        <Toggle
          label="Mono fold"
          checked={dsp.stereo.mono}
          onChange={(v) => applyDsp((d) => { d.stereo.mono = v; return d; })}
          hint="Sum to mono — useful for checking mono compatibility"
        />
        <Slider
          label="Limiter ceiling"
          value={dsp.limiter.ceilingDb}
          min={-24}
          max={-0.5}
          unit=" dBFS"
          onChange={(v) => applyDsp((d) => { d.limiter.ceilingDb = v; return d; })}
        />
        <Slider
          label="Limiter release"
          value={dsp.limiter.releaseMs}
          min={5}
          max={2000}
          unit=" ms"
          onChange={(v) => applyDsp((d) => { d.limiter.releaseMs = v; return d; })}
        />
        <Toggle
          label="Limiter enabled"
          checked={dsp.limiter.enabled}
          onChange={(v) => applyDsp((d) => { d.limiter.enabled = v; return d; })}
          hint="Output protection — keep enabled for everyday listening"
        />
      </Panel>
    </div>
  );
}
