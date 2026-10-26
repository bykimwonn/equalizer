import React, { useEffect, useMemo, useRef, useState } from 'react';
import { eqResponseDb, bandResponseDb, logSpace, freqToX, xToFreq, FREQ_MIN, FREQ_MAX } from '../curve.js';

/**
 * Interactive parametric EQ editor.
 * The curve is the analytic magnitude response of the actual filter
 * coefficients (engine/dsp/biquad.js) — identical math to the DSP chain.
 */
export default function EqEditor({ bands, sampleRate = 48000, onChange, selected, onSelect, height = 320 }) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [hover, setHover] = useState(null);
  const freqs = useMemo(() => logSpace(180), []);
  const gainMin = -15;
  const gainMax = 15;

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const yFor = (db) => h * (1 - (db - gainMin) / (gainMax - gainMin));
    const xFor = (f) => freqToX(f, w);

    // grid: dB lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = 'rgba(139,152,165,0.7)';
    ctx.font = '10px system-ui, sans-serif';
    for (let db = gainMin; db <= gainMax; db += 5) {
      const y = yFor(db);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${db > 0 ? '+' : ''}${db} dB`, 4, y - 3);
    }
    // freq lines
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = xFor(f);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 16);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x - 6, h - 4);
    }

    // zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, yFor(0));
    ctx.lineTo(w, yFor(0));
    ctx.stroke();

    // per-band faint curves
    for (let i = 0; i < bands.length; i++) {
      const resp = bandResponseDb(bands[i], sampleRate, freqs);
      ctx.beginPath();
      resp.forEach((db, k) => {
        const x = xFor(freqs[k]);
        const y = yFor(db);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = i === selected ? 'rgba(34,211,238,0.35)' : 'rgba(139,152,165,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // composite curve
    const resp = eqResponseDb(bands, sampleRate, freqs);
    ctx.beginPath();
    resp.forEach((db, k) => {
      const x = xFor(freqs[k]);
      const y = yFor(db);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(34,211,238,0.45)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // nodes
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const x = xFor(b.freq);
      const y = yFor(b.gainDb);
      ctx.beginPath();
      ctx.arc(x, y, i === selected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = b.enabled ? (i === selected ? '#22d3ee' : '#9fdbe6') : 'rgba(139,152,165,0.4)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,13,16,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  useEffect(draw, [bands, selected, sampleRate, height, hover]);

  const pickBand = (clientX, clientY) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = -1;
    let bestDist = 18;
    bands.forEach((b, i) => {
      const bx = freqToX(b.freq, rect.width);
      const by = rect.height * (1 - (b.gainDb - gainMin) / (gainMax - gainMin));
      const d = Math.hypot(bx - x, by - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  const onMouseDown = (e) => {
    const idx = pickBand(e.clientX, e.clientY);
    if (idx >= 0) {
      onSelect(idx);
      dragRef.current = { idx };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const onMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const idx = pickBand(e.clientX, e.clientY);
    setHover(idx);
    if (!dragRef.current) return;
    const { idx: di } = dragRef.current;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const freq = Math.max(FREQ_MIN, Math.min(FREQ_MAX, xToFreq(x, rect.width)));
    const gainDb = Math.max(gainMin, Math.min(gainMax, gainMin + (1 - y / rect.height) * (gainMax - gainMin)));
    onChange(di, { freq: Math.round(freq), gainDb: Math.round(gainDb * 10) / 10 });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onWheel = (e) => {
    const idx = pickBand(e.clientX, e.clientY);
    if (idx < 0) return;
    e.preventDefault();
    const b = bands[idx];
    const q = Math.max(0.1, Math.min(10, b.q * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
    onChange(idx, { q: Math.round(q * 100) / 100 });
  };

  return (
    <div className="eq-editor">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height }}
        onPointerDown={onMouseDown}
        onPointerMove={onMouseMove}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          setHover(null);
        }}
        onWheel={onWheel}
      />
      <div className="eq-hint">Drag nodes to set frequency/gain · scroll on a node to change Q</div>
    </div>
  );
}
