/**
 * Strict validation of AI-proposed DSP settings.
 *
 * Rules:
 *  - Only the documented numeric/boolean fields are accepted; every other key
 *    in the AI payload is discarded (no code, strings-as-instructions, etc.).
 *  - Structurally invalid values (NaN, wrong type) reject the whole proposal
 *    field (field is dropped, not applied).
 *  - Out-of-range numeric values are clamped to safe bounds with a warning
 *    recorded — the DSP engine must never see unrestricted AI output.
 */
import { defaultSettings } from './dsp/chain.js';
import { FILTER_TYPES } from './dsp/biquad.js';

export const BOUNDS = Object.freeze({
  inputGainDb: [-24, 24],
  outputGainDb: [-24, 24],
  eqBand: {
    freq: [20, 20000],
    gainDb: [-12, 12],
    q: [0.1, 10]
  },
  bass: {
    gainDb: [-12, 12],
    subGainDb: [-12, 12],
    harmonics: [0, 1]
  },
  clarity: {
    presenceDb: [-12, 12],
    airDb: [-12, 12],
    transients: [0, 1]
  },
  compressor: {
    thresholdDb: [-60, 0],
    ratio: [1, 20],
    attackMs: [0.1, 200],
    releaseMs: [5, 2000],
    kneeDb: [0, 24],
    makeupDb: [-12, 12],
    crossoverHz: [40, 2000]
  },
  limiter: {
    ceilingDb: [-12, -0.5],
    releaseMs: [5, 2000]
  },
  stereo: {
    width: [0, 2],
    balance: [-1, 1]
  },
  loudness: {
    targetLufs: [-31, -5],
    maxGainDb: [0, 12]
  }
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Validate a numeric field. Returns { ok:true, value, clamped } | { ok:false, reason }.
 */
function num(value, [lo, hi], name, warnings) {
  if (value === undefined || value === null) return { ok: false, reason: `${name} missing` };
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return { ok: false, reason: `${name} is not a finite number` };
  const c = clamp(n, lo, hi);
  if (c !== n) {
    warnings.push(`${name} clamped from ${n} to ${c} (bounds ${lo}..${hi})`);
  }
  return { ok: true, value: c };
}

function bool(value, dflt) {
  return value === undefined ? dflt : value === true;
}

/**
 * Validate a full (possibly partial) AI settings proposal against the schema.
 *
 * @param {object} raw proposal from an AI provider (parsed JSON)
 * @param {object} baseSettings current settings used as the merge base
 * @returns {{ok:boolean, settings:object|null, warnings:string[], errors:string[], appliedFields:number}}
 */
export function validateAiSettings(raw, baseSettings = defaultSettings()) {
  const warnings = [];
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, settings: null, warnings, errors: ['proposal must be an object'], appliedFields: 0 };
  }

  const base = JSON.parse(JSON.stringify(baseSettings));
  const out = defaultSettings();
  Object.assign(out, base);
  let applied = 0;

  // scalar gains
  for (const key of ['inputGainDb', 'outputGainDb']) {
    if (raw[key] !== undefined) {
      const r = num(raw[key], BOUNDS[key], key, warnings);
      if (r.ok) {
        out[key] = r.value;
        applied++;
      } else errors.push(r.reason);
    }
  }

  // EQ
  if (raw.eq !== undefined) {
    if (typeof raw.eq !== 'object' || raw.eq === null) {
      errors.push('eq must be an object');
    } else {
      if (raw.eq.enabled !== undefined) out.eq.enabled = bool(raw.eq.enabled, out.eq.enabled);
      if (raw.eq.bands !== undefined) {
        if (!Array.isArray(raw.eq.bands)) {
          errors.push('eq.bands must be an array');
        } else {
          const bands = out.eq.bands.map((b) => ({ ...b }));
          for (const b of raw.eq.bands) {
            if (!b || typeof b !== 'object') {
              errors.push('eq.bands entries must be objects');
              continue;
            }
            const idx = Number(b.id ?? b.index);
            if (!Number.isInteger(idx) || idx < 0 || idx >= bands.length) {
              errors.push(`eq.bands: invalid band index ${b.id ?? b.index}`);
              continue;
            }
            const band = bands[idx];
            if (b.type !== undefined) {
              if (FILTER_TYPES.includes(b.type)) band.type = b.type;
              else errors.push(`eq.bands[${idx}]: invalid type ${b.type}`);
            }
            if (b.freq !== undefined) {
              const r = num(b.freq, BOUNDS.eqBand.freq, `eq.bands[${idx}].freq`, warnings);
              if (r.ok) {
                band.freq = r.value;
                applied++;
              } else errors.push(r.reason);
            }
            if (b.gainDb !== undefined) {
              const r = num(b.gainDb, BOUNDS.eqBand.gainDb, `eq.bands[${idx}].gainDb`, warnings);
              if (r.ok) {
                band.gainDb = r.value;
                applied++;
              } else errors.push(r.reason);
            }
            if (b.q !== undefined) {
              const r = num(b.q, BOUNDS.eqBand.q, `eq.bands[${idx}].q`, warnings);
              if (r.ok) {
                band.q = r.value;
                applied++;
              } else errors.push(r.reason);
            }
            if (b.enabled !== undefined) band.enabled = b.enabled === true;
            bands[idx] = band;
          }
          out.eq.bands = bands;
        }
      }
    }
  }

  // module blocks: bass / clarity / compressor / limiter / stereo / loudness
  const moduleSpec = {
    bass: {
      keys: {
        gainDb: BOUNDS.bass.gainDb,
        subGainDb: BOUNDS.bass.subGainDb,
        harmonics: BOUNDS.bass.harmonics
      },
      bools: ['enabled', 'protection']
    },
    clarity: {
      keys: {
        presenceDb: BOUNDS.clarity.presenceDb,
        airDb: BOUNDS.clarity.airDb,
        transients: BOUNDS.clarity.transients
      },
      bools: ['enabled']
    },
    compressor: {
      keys: {
        thresholdDb: BOUNDS.compressor.thresholdDb,
        ratio: BOUNDS.compressor.ratio,
        attackMs: BOUNDS.compressor.attackMs,
        releaseMs: BOUNDS.compressor.releaseMs,
        kneeDb: BOUNDS.compressor.kneeDb,
        makeupDb: BOUNDS.compressor.makeupDb,
        crossoverHz: BOUNDS.compressor.crossoverHz
      },
      bools: ['enabled', 'linked', 'multiband']
    },
    limiter: {
      keys: {
        ceilingDb: BOUNDS.limiter.ceilingDb,
        releaseMs: BOUNDS.limiter.releaseMs
      },
      bools: ['enabled']
    },
    stereo: {
      keys: {
        width: BOUNDS.stereo.width,
        balance: BOUNDS.stereo.balance
      },
      bools: ['mono']
    },
    loudness: {
      keys: {
        targetLufs: BOUNDS.loudness.targetLufs,
        maxGainDb: BOUNDS.loudness.maxGainDb
      },
      bools: ['normalization']
    }
  };

  for (const [mod, spec] of Object.entries(moduleSpec)) {
    if (raw[mod] === undefined) continue;
    if (typeof raw[mod] !== 'object' || raw[mod] === null) {
      errors.push(`${mod} must be an object`);
      continue;
    }
    for (const key of Object.keys(spec.keys)) {
      if (raw[mod][key] === undefined) continue;
      const r = num(raw[mod][key], spec.keys[key], `${mod}.${key}`, warnings);
      if (r.ok) {
        out[mod][key] = r.value;
        applied++;
      } else {
        errors.push(r.reason);
      }
    }
    for (const key of spec.bools) {
      if (raw[mod][key] !== undefined) {
        if (typeof raw[mod][key] === 'boolean') {
          out[mod][key] = raw[mod][key];
          applied++;
        } else {
          errors.push(`${mod}.${key} must be boolean`);
        }
      }
    }
    // re-normalize module objects through the chain setter semantics
  }

  // bypass may be proposed but never enables itself silently in adaptive mode —
  // the controller decides. Still validate type.
  if (raw.bypass !== undefined && typeof raw.bypass === 'boolean') out.bypass = raw.bypass;

  if (errors.length > 0 && applied === 0) {
    return { ok: false, settings: null, warnings, errors, appliedFields: 0 };
  }
  return {
    ok: true,
    settings: out,
    warnings,
    errors,
    appliedFields: applied
  };
}

/**
 * Shape of an AI recommendation document the app requests from providers.
 * Providers must return JSON conforming to this; the parser is tolerant of
 * ```json fences and surrounding prose.
 */
export const AI_PROPOSAL_EXAMPLE = Object.freeze({
  profileId: 'vocal-clarity',
  explanation: 'Vocal energy dominates 1–3 kHz; reduce low mud and lift presence.',
  confidence: 0.62,
  settings: {
    eq: { bands: [{ id: 5, gainDb: 1.5 }, { id: 3, gainDb: -1 }] },
    clarity: { presenceDb: 2 },
    bass: { gainDb: -1 }
  }
});

/** Parse model output text into a proposal object (tolerant JSON extraction). */
export function parseAiProposal(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'empty response', proposal: null };
  }
  let t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  else {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'proposal is not an object', proposal: null };
    return {
      ok: true,
      proposal: {
        profileId: typeof obj.profileId === 'string' ? obj.profileId.slice(0, 64) : null,
        explanation: typeof obj.explanation === 'string' ? obj.explanation.slice(0, 2000) : '',
        confidence: Number.isFinite(obj.confidence) ? clamp(obj.confidence, 0, 1) : null,
        settings: obj.settings && typeof obj.settings === 'object' ? obj.settings : {}
      }
    };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e.message}`, proposal: null };
  }
}
