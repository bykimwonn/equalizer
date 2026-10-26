/**
 * Audio backends.
 *
 * - NativeWasapiBackend: real Windows audio I/O via the bt_wasapi native addon
 *   (WASAPI capture — endpoint loopback or process-loopback excluding the BT
 *   process tree — plus WASAPI render to the selected output device).
 * - SimulationBackend: development/test signal generator. It drives the SAME
 *   DSP engine and analysis pipeline but performs NO real device I/O. The UI
 *   always labels it as "Simulation — no real audio I/O". It exists so the app
 *   and tests run on machines without the Windows native module; it is never
 *   presented as real playback.
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const require = createRequire(import.meta.url);

export class NativeWasapiBackend extends EventEmitter {
  constructor() {
    super();
    this.id = 'wasapi';
    this.label = 'WASAPI (native)';
    this.native = null;
    this.stream = null;
    this.unavailableReason = null;
    this._loadNative();
  }

  /** Load (or reload) the native addon. Retried on every start/enumerate so a
   *  module built after app launch is picked up without restarting the app. */
  _loadNative() {
    if (this.native) return true;
    if (os.platform() !== 'win32') {
      this.unavailableReason = `native WASAPI backend requires Windows (current platform: ${os.platform()})`;
      return false;
    }
    try {
      this.native = require('../../native/wasapi/build/Release/bt_wasapi.node');
      this.unavailableReason = null;
      return true;
    } catch (e) {
      this.unavailableReason = `native module not loaded: ${e.message}. Run "npm run build:native" on Windows with VS Build Tools installed, then press Refresh.`;
      return false;
    }
  }

  get available() {
    return !!this.native && !this.streamError;
  }

  get statusDetail() {
    if (!this.native) return this.unavailableReason;
    return 'WASAPI engine ready';
  }

  enumerateDevices() {
    if (!this._loadNative()) return [];
    return this.native.enumerateDevices();
  }

  /**
   * @param {object} opts
   * @param {string} [opts.captureDeviceId] 'default' or device id
   * @param {'process-loopback'|'loopback'} opts.captureMode
   * @param {string} [opts.renderDeviceId]
   * @param {number} opts.sampleRate
   * @param {number} opts.blockFrames
   * @param {(L:Float32Array,R:Float32Array)=>void} opts.process in-place DSP callback
   */
  start({ captureDeviceId = 'default', captureMode = 'process-loopback', renderDeviceId = 'default', sampleRate = 48000, blockFrames = 256, process: processFn }) {
    if (!this._loadNative()) throw new Error(this.unavailableReason ?? 'native backend unavailable');
    this.stream = this.native.startStream({
      captureDeviceId,
      captureMode,
      excludePid: currentPid(),
      renderDeviceId,
      sampleRate,
      blockFrames,
      channels: 2,
      process: processFn
    });
    return { ok: true };
  }

  stop() {
    if (this.stream) {
      try {
        this.stream.stop();
      } catch {
        // stream already stopped
      }
      this.stream = null;
    }
  }
}

function currentPid() {
  // the native addon excludes the Electron process tree from process-loopback
  // capture so that our own render stream is never fed back into the input
  return process.pid;
}

/**
 * Development/test backend. Generates a deterministic musical-like test signal
 * (bass, chord, noise transients) that changes every ~25 s so content-change
 * detection and the adaptive controller can be exercised end-to-end.
 * NO real device I/O — always labeled as simulation in the UI.
 */
export class SimulationBackend extends EventEmitter {
  constructor() {
    super();
    this.id = 'simulation';
    this.label = 'Simulation (development only — no real audio I/O)';
    this.running = false;
    this._timer = null;
    this._phase = 0;
    this._section = 0;
  }

  get available() {
    return true;
  }

  get statusDetail() {
    return 'Simulation backend active — signal is generated locally, no devices involved';
  }

  enumerateDevices() {
    return [
      {
        id: 'sim-out',
        name: 'Simulated Output (no hardware)',
        isRender: true,
        isCapture: false,
        isDefault: true,
        sampleRates: [48000],
        channels: 2,
        note: 'simulation device'
      }
    ];
  }

  start({ sampleRate = 48000, blockFrames = 256, process }) {
    this.running = true;
    this.sampleRate = sampleRate;
    this.blockFrames = blockFrames;
    const L = new Float32Array(blockFrames);
    const R = new Float32Array(blockFrames);
    const sectionSamples = Math.floor(sampleRate * 25);

    const tick = () => {
      if (!this.running) return;
      const sec = this._section;
      // alternating "content": bass-heavy / mid-focused / bright
      const bassAmp = [0.45, 0.15, 0.2][sec % 3];
      const chordAmp = [0.15, 0.35, 0.2][sec % 3];
      const noiseAmp = [0.02, 0.03, 0.08][sec % 3];
      const bassFreq = [55, 65.4, 49][sec % 3];
      for (let i = 0; i < blockFrames; i++) {
        const t = this._phase / sampleRate;
        const bass = bassAmp * Math.sin(2 * Math.PI * bassFreq * t);
        const c1 = chordAmp * Math.sin(2 * Math.PI * 220 * t + 0.3 * Math.sin(2 * Math.PI * 2 * t));
        const c2 = chordAmp * 0.7 * Math.sin(2 * Math.PI * 277.2 * t);
        const c3 = chordAmp * 0.5 * Math.sin(2 * Math.PI * 329.6 * t);
        const hat = ((this._phase / (sampleRate / 8)) % 1 < 0.08 ? 1 : 0) * noiseAmp * (Math.random() * 2 - 1);
        const l = bass + c1 + c2 + hat;
        const r = bass + c1 + c3 + hat * 0.8;
        L[i] = l;
        R[i] = r;
        this._phase++;
        if (this._phase >= sectionSamples * (sec + 1)) this._section++;
      }
      try {
        process(L, R);
      } catch (e) {
        this.emit('error', e);
      }
    };

    // process in ~real time using timers (development pacing, not audio timing)
    const intervalMs = Math.max(1, Math.floor((blockFrames / sampleRate) * 1000));
    this._timer = setInterval(tick, intervalMs);
    return { ok: true };
  }

  stop() {
    this.running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
