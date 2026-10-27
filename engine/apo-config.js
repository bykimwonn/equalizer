/**
 * APO configuration serializer.
 *
 * The system-wide APO (native/apo) reads %ProgramData%\BT-AI-Equalizer\apo-config.bin,
 * polled by an atomic version counter inside the real-time APOProcess — never
 * file I/O on the audio thread. This module turns validated DSP settings into
 * that file's exact byte layout.
 *
 * Implemented on DataView (standard ECMAScript) rather than Buffer float
 * helpers, so it behaves identically on every Node build and can be bundled.
 *
 * File layout (all little-endian):
 *   u32 magic   0x42544150  ('BTAP')
 *   u32 version (currently 1)
 *   u32 payload size in bytes (currently 216)
 *   payload: PackedApoParams
 *
 * PackedApoParams (216 bytes, deliberately padding-free — every member 4 bytes,
 * so MSVC and this serializer agree byte-for-byte; static_asserts in apo_dsp.h
 * verify the C++ side):
 *   float inputGainDb        @ 0
 *   float outputGainDb       @ 4
 *   EqBand bands[10]         @ 8     (20 bytes each)
 *     float freq   @ +0
 *     float q      @ +4
 *     float gainDb @ +8
 *     int   type   @ +12   (0=peaking 1=lowshelf 2=highshelf)
 *     int   enabled@ +16   (0/1)
 *   float limiterCeilingDb   @ 208
 *   int   bypass             @ 212
 */

export const APO_MAGIC = 0x42544150; // 'BTAP' as a little-endian u32
export const APO_VERSION = 1;
export const EQBAND_SIZE = 20;
export const APO_PARAMS_SIZE = 216;
export const APO_HEADER_SIZE = 12;
export const APO_FILE_SIZE = APO_HEADER_SIZE + APO_PARAMS_SIZE;

const FILTER_TYPE_IDS = { peaking: 0, lowshelf: 1, highshelf: 2 };

function f32(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function viewOf(bytes) {
  if (bytes instanceof DataView) return bytes;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/**
 * Serialize DSP settings (engine settings schema) to the APO file bytes.
 * Values are written as-is; validation/clamping happens upstream
 * (engine/validate.js, DspChain.setSettings). Unknown/partial settings fall
 * back to neutral values.
 * @param {object} settings
 * @returns {Uint8Array}
 */
export function serializeApoConfig(settings = {}) {
  const u8 = new Uint8Array(APO_FILE_SIZE);
  const dv = new DataView(u8.buffer);

  // header
  dv.setUint32(0, APO_MAGIC, true);
  dv.setUint32(4, APO_VERSION, true);
  dv.setUint32(8, APO_PARAMS_SIZE, true);

  // payload
  const base = APO_HEADER_SIZE;
  dv.setFloat32(base + 0, f32(settings.inputGainDb), true);
  dv.setFloat32(base + 4, f32(settings.outputGainDb), true);

  const bands = Array.isArray(settings.eq?.bands) ? settings.eq.bands : [];
  const eqEnabled = settings.eq?.enabled !== false;
  for (let i = 0; i < 10; i++) {
    const off = base + 8 + i * EQBAND_SIZE;
    const b = bands[i];
    if (!b) {
      // neutral band
      dv.setFloat32(off + 0, 1000, true);
      dv.setFloat32(off + 4, 1, true);
      dv.setFloat32(off + 8, 0, true);
      dv.setInt32(off + 12, 0, true);
      dv.setInt32(off + 16, 1, true);
      continue;
    }
    dv.setFloat32(off + 0, f32(b.freq, 1000), true);
    dv.setFloat32(off + 4, f32(b.q, 1), true);
    dv.setFloat32(off + 8, f32(b.gainDb), true);
    dv.setInt32(off + 12, FILTER_TYPE_IDS[b.type] ?? 0, true);
    dv.setInt32(off + 16, eqEnabled && b.enabled !== false ? 1 : 0, true);
  }

  const ceilingDb = f32(settings.limiter?.ceilingDb, -1);
  dv.setFloat32(base + 208, Math.min(-0.5, Math.max(-24, ceilingDb)), true);
  dv.setInt32(base + 212, settings.bypass === true ? 1 : 0, true);

  return u8;
}

/**
 * Parse bytes back to a plain object (used by tests and diagnostics).
 * @param {Uint8Array|Buffer|DataView} bytes
 */
export function parseApoConfig(bytes) {
  const dv = viewOf(bytes);
  if (dv.byteLength < APO_FILE_SIZE) throw new RangeError('buffer too small');
  if (dv.getUint32(0, true) !== APO_MAGIC) throw new RangeError('bad magic');
  const version = dv.getUint32(4, true);
  const size = dv.getUint32(8, true);
  if (size !== APO_PARAMS_SIZE) throw new RangeError(`unexpected payload size ${size}`);
  const base = APO_HEADER_SIZE;
  const bands = [];
  for (let i = 0; i < 10; i++) {
    const off = base + 8 + i * EQBAND_SIZE;
    bands.push({
      freq: dv.getFloat32(off + 0, true),
      q: dv.getFloat32(off + 4, true),
      gainDb: dv.getFloat32(off + 8, true),
      type: dv.getInt32(off + 12, true),
      enabled: dv.getInt32(off + 16, true) === 1
    });
  }
  return {
    version,
    inputGainDb: dv.getFloat32(base + 0, true),
    outputGainDb: dv.getFloat32(base + 4, true),
    bands,
    limiterCeilingDb: dv.getFloat32(base + 208, true),
    bypass: dv.getInt32(base + 212, true) === 1
  };
}
