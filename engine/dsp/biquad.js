/**
 * Biquad filter design and processing (RBJ Audio EQ Cookbook).
 * Pure functions + tiny state objects; no allocations in the sample loop.
 */

export const FILTER_TYPES = Object.freeze([
  'peaking',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'notch',
  'bandpass'
]);

const VALID_TYPES = new Set(FILTER_TYPES);

function assertFinite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RangeError(`${name} must be a finite number, got ${v}`);
  }
}

/**
 * Design a normalized biquad (a0 = 1).
 * @param {string} type one of FILTER_TYPES
 * @param {number} freq center/corner frequency in Hz (0 < f < nyquist)
 * @param {number} Q quality factor (> 0)
 * @param {number} gainDb shelving/peaking gain in dB (ignored for lp/hp/notch/bp)
 * @param {number} sampleRate Hz (> 0)
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function designBiquad(type, freq, Q, gainDb, sampleRate) {
  if (!VALID_TYPES.has(type)) throw new RangeError(`unknown filter type: ${type}`);
  assertFinite('freq', freq);
  assertFinite('Q', Q);
  assertFinite('gainDb', gainDb);
  assertFinite('sampleRate', sampleRate);
  if (sampleRate <= 0) throw new RangeError('sampleRate must be > 0');
  const nyquist = sampleRate / 2;
  if (!(freq > 0 && freq < nyquist * 0.999)) {
    throw new RangeError(`freq must be in (0, ${nyquist * 0.999}), got ${freq}`);
  }
  if (!(Q > 0)) throw new RangeError(`Q must be > 0, got ${Q}`);
  if (Math.abs(gainDb) > 60) throw new RangeError(`|gainDb| must be <= 60, got ${gainDb}`);

  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case 'peaking': {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      // RBJ shelf slope S = 1
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'highshelf': {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'lowpass': {
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'notch': {
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': {
      // constant 0 dB peak gain
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    default:
      throw new RangeError(`unhandled type ${type}`);
  }

  const out = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  for (const k of Object.values(out)) {
    if (!Number.isFinite(k)) throw new RangeError('designed coefficients are not finite');
  }
  return out;
}

/** Fresh per-channel filter memory. */
export function createBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** Reset memory in-place. */
export function resetBiquadState(s) {
  s.x1 = 0;
  s.x2 = 0;
  s.y1 = 0;
  s.y2 = 0;
  return s;
}

/**
 * Process one sample through a biquad (Direct Form I).
 */
export function processSample(c, s, x) {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

/**
 * Process a slice of a Float32Array in-place.
 */
export function processBlockInPlace(c, s, buf, offset = 0, len = buf.length - offset) {
  let { x1, x2, y1, y2 } = s;
  const { b0, b1, b2, a1, a2 } = c;
  const end = offset + len;
  for (let i = offset; i < end; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  s.x1 = x1;
  s.x2 = x2;
  s.y1 = y1;
  s.y2 = y2;
}

/**
 * Complex magnitude response |H(e^jw)| of a designed biquad at a frequency.
 * Used for the UI response curve and for tests.
 */
export function magnitudeAt(c, freq, sampleRate) {
  assertFinite('freq', freq);
  assertFinite('sampleRate', sampleRate);
  const w = (2 * Math.PI * freq) / sampleRate;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w);
  const sin2W = Math.sin(2 * w);
  // num = b0 + b1 z^-1 + b2 z^-2
  const nRe = c.b0 + c.b1 * cosW + c.b2 * cos2W;
  const nIm = -(c.b1 * sinW + c.b2 * sin2W);
  // den = 1 + a1 z^-1 + a2 z^-2
  const dRe = 1 + c.a1 * cosW + c.a2 * cos2W;
  const dIm = -(c.a1 * sinW + c.a2 * sin2W);
  const nMag = Math.hypot(nRe, nIm);
  const dMag = Math.hypot(dRe, dIm);
  return nMag / dMag;
}

/** Magnitude response in dB. */
export function magnitudeDbAt(c, freq, sampleRate) {
  return 20 * Math.log10(Math.max(1e-12, magnitudeAt(c, freq, sampleRate)));
}

/**
 * Stability check: all poles strictly inside the unit circle.
 * For normalized biquad: |a2| < 1 and |a1| < 1 + a2.
 */
export function isStable(c) {
  return (
    Number.isFinite(c.a1) &&
    Number.isFinite(c.a2) &&
    Math.abs(c.a2) < 1 &&
    Math.abs(c.a1) < 1 + c.a2 + 1e-12
  );
}
