import React from 'react';

export function Panel({ title, sub, children, className = '', right = null }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="panel-head">
          <div>
            <h3>{title}</h3>
            {sub && <p className="panel-sub">{sub}</p>}
          </div>
          {right}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Slider({ label, value, min, max, step = 0.1, unit = '', onChange, format, disabled }) {
  const display = format ? format(value) : `${Number(value).toFixed(step >= 1 ? 0 : 1)}${unit}`;
  return (
    <label className={`slider-row ${disabled ? 'disabled' : ''}`}>
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{display}</span>
    </label>
  );
}

export function Toggle({ label, checked, onChange, disabled, hint }) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`} title={hint}>
      <span className="toggle-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle ${checked ? 'on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </label>
  );
}

export function Select({ label, value, options, onChange }) {
  return (
    <label className="select-row">
      <span className="select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function StatusPill({ state, children }) {
  return (
    <span className={`pill ${state}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Button({ children, onClick, variant = 'ghost', disabled, title, className = '' }) {
  return (
    <button className={`btn ${variant} ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}
