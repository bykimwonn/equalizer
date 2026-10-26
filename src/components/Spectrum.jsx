import React, { useEffect, useRef } from 'react';

/**
 * Live spectrum + level meters, drawn from actual engine telemetry
 * (features.spectrumSnapshot of the processed signal). Nothing here is
 * synthesized — when the engine is idle the display is flat by definition.
 */
export default function Spectrum({ telemetry, height = 190 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
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

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const spectrum = telemetry?.spectrum ?? [];
    const n = spectrum.length || 64;
    const barW = w / n;

    // spectrum bars (log-band magnitudes from the FFT)
    for (let i = 0; i < n; i++) {
      const mag = Math.max(0, Math.min(1, spectrum[i] * 2.2));
      const bh = Math.pow(mag, 0.6) * (h - 8);
      const x = i * barW;
      const grad = ctx.createLinearGradient(0, h - bh, 0, h);
      grad.addColorStop(0, 'rgba(34,211,238,0.85)');
      grad.addColorStop(1, 'rgba(34,211,238,0.12)');
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, h - bh, barW - 2, bh);
    }

    // freq labels
    ctx.fillStyle = 'rgba(139,152,165,0.8)';
    ctx.font = '10px system-ui, sans-serif';
    const labels = [
      [20, '20'],
      [100, '100'],
      [500, '500'],
      [2000, '2k'],
      [8000, '8k'],
      [20000, '20k']
    ];
    for (const [f, text] of labels) {
      const pos = Math.log10(f / 20) / Math.log10(1000);
      ctx.fillText(text, Math.min(w - 22, pos * w), h - 2);
    }
  }, [telemetry, height]);

  return (
    <div className="spectrum-wrap">
      <canvas ref={canvasRef} style={{ width: '100%', height }} />
    </div>
  );
}

/** Input/output peak meters driven by real engine meter state. */
export function Meters({ telemetry }) {
  const inPeak = telemetry?.input?.peak ?? 0;
  const outPeak = telemetry?.output?.peak ?? 0;
  const inDb = telemetry?.input?.rmsDb ?? -160;
  const outDb = telemetry?.output?.rmsDb ?? -160;

  const bar = (peak, db, label) => {
    const pct = Math.max(0, Math.min(1, peak));
    const dbPct = Math.max(0, Math.min(1, (db + 60) / 60));
    const hot = peak > 0.98;
    return (
      <div className="meter">
        <div className="meter-label">
          {label}
          <span>{db <= -159 ? '−∞' : db.toFixed(1)} dB</span>
        </div>
        <div className={`meter-track ${hot ? 'hot' : ''}`}>
          <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
          <div className="meter-marker" style={{ left: `${dbPct * 100}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="meters">
      {bar(inPeak, inDb, 'Input')}
      {bar(outPeak, outDb, 'Output')}
    </div>
  );
}
