/**
 * EngineHost — owns the AudioEngine, the selected backend, and the adaptive
 * controller. Bridges real PCM buffers → DSP → backend render, and publishes
 * telemetry to the renderer.
 *
 * Thread-safety model: the JS engine runs on the main-process event loop.
 * The native backend delivers PCM buffers via callback; parameter changes are
 * applied between blocks (block-boundary coefficient updates), never inside a
 * sample loop. No network/disk work happens inside the buffer callback.
 */
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AudioEngine } from '../../engine/engine.js';
import { AdaptiveController } from '../../engine/controller.js';
import { profileSettings } from '../../engine/profiles.js';
import { defaultSettings } from '../../engine/dsp/chain.js';
import { serializeApoConfig } from '../../engine/apo-config.js';
import { NativeWasapiBackend, SimulationBackend } from './backends.js';

const TELEMETRY_HZ = 30;

/** Default APO config location (Windows). Null elsewhere — the APO is Windows-only. */
function defaultApoConfigPath() {
  if (process.platform !== 'win32') return null;
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(programData, 'BT-AI-Equalizer', 'apo-config.bin');
}

/**
 * Same-device duplication risk for tap-and-rerender capture.
 *
 * WASAPI loopback — including process loopback — is a NON-DESTRUCTIVE TAP,
 * not a reroute: Windows keeps rendering the captured apps' original audio to
 * their endpoint while this app renders its processed copy to the render
 * device. When both copies are audible (the normal case — apps play to the
 * default device and BT renders to the same device), the user hears BOTH:
 * doubling and comb-filtering that sounds hollow/harsh/echoey ("too much
 * treble"), plus possible output clipping from the summed level.
 * EXCLUDE_TARGET_PROCESS_TREE only prevents the feedback *loop* (BT hearing
 * its own render); it does not mute or divert the original playback.
 *
 * Single-path (no duplication) options: 'loopback-to-cable' (apps render to
 * an inaudible virtual cable, BT enhances onto the real device) and 'apo'
 * (in-place DSP inside the Windows audio engine).
 *
 * @param {string} routingMode
 * @returns {{kind: string, message: string} | null}
 */
export function duplicationRisk(routingMode) {
  if (routingMode !== 'process-loopback') return null;
  return {
    kind: 'same-device-doubling',
    message:
      'Loopback capture is a tap, not a reroute: Windows keeps playing the original audio while BT renders an enhanced copy. ' +
      'If both are audible you hear a doubled, comb-filtered signal (hollow/harsh/echoey) — this is not an EQ bug. ' +
      'For clean single-path sound use Routing → "Loopback to virtual cable" (VB-CABLE) or the APO path. ' +
      'To audition the untouched original, press Stop — the bypass toggle keeps the doubled signal playing.'
  };
}

export class EngineHost extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../settings-store.js').SettingsStore} opts.settingsStore
   * @param {import('../ai/manager.js').AiManager} opts.aiManager
   * @param {string|null} [opts.apoConfigPath] override for tests
   */
  constructor({ settingsStore, aiManager, apoConfigPath = undefined }) {
    super();
    this.settingsStore = settingsStore;
    this.aiManager = aiManager;
    this.engine = null;
    this.apoConfigPath = apoConfigPath === undefined ? defaultApoConfigPath() : apoConfigPath;
    this.apoStatus = { lastWriteAt: null, lastError: null, lastBytes: 0 };
    this._pendingPersist = null;
    this._pendingApoWrite = null;
    this.controller = new AdaptiveController({
      aiClient: {
        recommend: async (features, preferences, mode) => {
          const res = await this.aiManager.recommend(features, preferences, mode);
          return res.ok ? { ok: true, proposal: res.proposal, provider: res.provider } : { ok: false, error: res.error };
        }
      },
      onApply: (settings, meta) => {
        this.applySettings(settings, meta);
        this.emit('ai-suggestion', { applied: true, meta, settings });
      },
      onSuggest: (suggestion) => {
        this.emit('ai-suggestion', { applied: false, suggestion });
      }
    });
    this.backends = {
      wasapi: new NativeWasapiBackend(),
      simulation: new SimulationBackend()
    };
    this.activeBackend = null;
    this.running = false;
    this.status = {
      state: 'stopped',
      backend: null,
      backendDetail: '',
      duplication: null,
      routingMode: null,
      device: null,
      lastError: null,
      restarts: 0
    };
    this._telemetryTimer = null;
    this._lastTelemetry = null;
    this._watchdog = null;
  }

  async init() {
    const app = await this.settingsStore.getAppSettings();
    const dsp = await this.settingsStore.getDspSettings();
    this.engine = new AudioEngine({
      sampleRate: app.audio.sampleRate,
      blockFrames: app.audio.blockFrames,
      settings: dsp
    });
    this.controller.setMode(app.mode);
    this.controller.setCurrentSettings(dsp);
    const pers = await this.settingsStore.getPersonalization();
    this.controller.setPreferences(pers.preferences);
    this._writeApoConfig(dsp);
    return { ok: true };
  }

  /** Which backends exist and whether the native one loaded. */
  backendStatus() {
    return Object.fromEntries(
      Object.entries(this.backends).map(([id, b]) => [
        id,
        { id: b.id, label: b.label, available: b.available, detail: b.statusDetail }
      ])
    );
  }

  async enumerateDevices() {
    const app = await this.settingsStore.getAppSettings();
    const backend = this.backends[app.audio.backend] ?? this.backends.wasapi;
    const devices = backend.enumerateDevices();
    return {
      backend: backend.id,
      backendAvailable: backend.available,
      backendDetail: backend.statusDetail,
      routingMode: app.audio.routingMode,
      devices
    };
  }

  async start() {
    const app = await this.settingsStore.getAppSettings();
    const backendId = app.audio.backend === 'simulation' ? 'simulation' : 'wasapi';
    let backend = this.backends[backendId];

    // honest fallback: if native is unavailable, do NOT silently pretend real
    // audio works — surface the reason and require explicit sim selection.
    if (!backend.available) {
      this.status = {
        ...this.status,
        state: 'error',
        backend: backend.id,
        backendDetail: backend.statusDetail,
        lastError: backend.statusDetail
      };
      this.emit('status', this.status);
      return { ok: false, error: backend.statusDetail, requiresSimulation: true };
    }

    try {
      backend.stop();
      const processFn = (L, R) => this._processBuffers(L, R);
      backend.start({
        captureDeviceId: app.audio.captureDeviceId,
        captureMode: app.audio.routingMode === 'loopback-to-cable' ? 'loopback' : 'process-loopback',
        renderDeviceId: app.audio.renderDeviceId,
        sampleRate: app.audio.sampleRate,
        blockFrames: app.audio.blockFrames,
        process: processFn
      });
      this.activeBackend = backend;
      this.running = true;
      // Real-device tap-and-rerender backends can double what the user hears
      // (see duplicationRisk): the captured apps still render their original
      // audio while we render our processed copy. Surface it honestly in
      // status → UI banner + diagnostics instead of pretending clean output.
      const duplication = backend.id === 'wasapi' ? duplicationRisk(app.audio.routingMode) : null;
      this.status = {
        state: 'running',
        backend: backend.id,
        backendDetail: backend.statusDetail,
        routingMode: app.audio.routingMode,
        device: app.audio.renderDeviceId,
        duplication,
        lastError: null,
        restarts: this.status.restarts
      };
      this.emit('status', this.status);
      this._startTelemetry();
      this._startWatchdog();
      return { ok: true, status: this.status };
    } catch (e) {
      this.status = { ...this.status, state: 'error', lastError: String(e.message ?? e) };
      this.emit('status', this.status);
      return { ok: false, error: String(e.message ?? e) };
    }
  }

  async stop() {
    this.running = false;
    if (this.activeBackend) this.activeBackend.stop();
    if (this._telemetryTimer) clearInterval(this._telemetryTimer);
    if (this._watchdog) clearInterval(this._watchdog);
    this._telemetryTimer = null;
    this._watchdog = null;
    this.status = { ...this.status, state: 'stopped', duplication: null };
    this.emit('status', this.status);
    return { ok: true };
  }

  /** DSP chain settings (from UI or controller). Persisted asynchronously. */
  applySettings(settings, meta = {}) {
    if (!this.engine) return;
    this.engine.setSettings(settings);
    this.controller.setCurrentSettings(settings);
    // fire-and-forget persistence — never blocks the audio path; shutdown() flushes
    this._pendingPersist = this.settingsStore.setDspSettings(settings).catch(() => {});
    // keep the system-wide APO's config snapshot in sync (if that route is used)
    this._writeApoConfig(settings);
    this.emit('settings-changed', { settings, meta });
  }

  /**
   * Write the APO config file consumed by the system-wide APO (native/apo).
   * Runs off the audio path; failures surface honestly in diagnostics rather
   * than being hidden (e.g. %ProgramData% not writable for non-admin users —
   * the registration script creates the folder with user-write ACL).
   */
  _writeApoConfig(settings) {
    if (!this.apoConfigPath) return;
    const target = this.apoConfigPath;
    let bytes;
    try {
      bytes = serializeApoConfig(settings);
    } catch (e) {
      this.apoStatus = { ...this.apoStatus, lastError: `serialize: ${e.message}` };
      return;
    }
    const tmp = `${target}.${process.pid}.tmp`;
    this._pendingApoWrite = fsp
      .mkdir(path.dirname(target), { recursive: true })
      .then(() => fsp.writeFile(tmp, bytes))
      .then(() => fsp.rename(tmp, target))
      .then(() => {
        this.apoStatus = { lastWriteAt: Date.now(), lastError: null, lastBytes: bytes.length };
      })
      .catch((e) => {
        this.apoStatus = {
          lastWriteAt: this.apoStatus.lastWriteAt,
          lastError: String(e.message ?? e),
          lastBytes: 0
        };
      });
  }

  async setMode(mode) {
    this.controller.setMode(mode);
    await this.settingsStore.setAppSettings({ mode });
    return { ok: true };
  }

  setBypass(bypass) {
    const s = this.engine.getSettings();
    s.bypass = !!bypass;
    this.applySettings(s, { source: 'user', reason: bypass ? 'bypass on' : 'bypass off' });
    return { ok: true, bypass: !!bypass };
  }

  /** The DSP processing path — runs per buffer from the active backend. */
  _processBuffers(L, R) {
    if (!this.engine) return;
    const res = this.engine.process(L, R);
    // feed the local controller every ~16 analysis frames (~0.3 s at 48 kHz)
    if (this.engine.blocksProcessed % 16 === 0) {
      const features = this.engine.features.latest;
      // async but never awaited inside the buffer path; errors are swallowed
      this.controller.onFeatures(features).catch(() => {});
    }
    if (res.clamps > 0) {
      this.emit('limiter-clamps', { clamps: res.clamps });
    }
    return res;
  }

  _startTelemetry() {
    if (this._telemetryTimer) clearInterval(this._telemetryTimer);
    this._telemetryTimer = setInterval(() => {
      if (!this.engine) return;
      const t = this.engine.getTelemetry();
      t.mode = this.controller.mode;
      t.status = this.status;
      t.pendingSuggestion = this.controller.pendingSuggestion
        ? {
            at: this.controller.pendingSuggestion.at,
            source: this.controller.pendingSuggestion.source,
            explanation: this.controller.pendingSuggestion.explanation,
            confidence: this.controller.pendingSuggestion.confidence
          }
        : null;
      this._lastTelemetry = t;
      this.emit('telemetry', t);
    }, Math.floor(1000 / TELEMETRY_HZ));
  }

  /** Recoverable-failure watchdog: restarts a stalled backend with backoff. */
  _startWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this.running || !this.engine) return;
      const stalled = this.engine.blocksProcessed === this._lastBlocks;
      this._lastBlocks = this.engine.blocksProcessed;
      if (stalled && this.status.state === 'running') {
        this.status = {
          ...this.status,
          state: 'recovering',
          lastError: 'audio stream stalled — restarting',
          restarts: (this.status.restarts ?? 0) + 1
        };
        this.emit('status', this.status);
        this.stop().then(() => this.start());
      }
    }, 5000);
  }

  getTelemetry() {
    return this._lastTelemetry;
  }

  /** Diagnostics snapshot for the Settings screen. */
  diagnostics() {
    return {
      status: this.status,
      backends: this.backendStatus(),
      engine: this.engine
        ? {
            blocksProcessed: this.engine.blocksProcessed,
            totalFrames: this.engine.totalFrames,
            nanGuardTrips: this.engine.nanGuardTrips,
            clipEvents: this.engine.clipEvents,
            avgProcessMsPerBlock: this.engine.getTelemetry().engine.avgProcessMsPerBlock
          }
        : null,
      controller: {
        mode: this.controller.mode,
        safetyActions: this.controller.safetyActions,
        history: this.controller.history.slice(-20)
      },
      apoConfig: {
        path: this.apoConfigPath,
        ...this.apoStatus
      }
    };
  }

  async shutdown() {
    await this.stop();
    // flush any in-flight settings persistence — clean quit must not race
    // the config writer (Windows especially: leftover tmp files / lost writes)
    if (this._pendingPersist) await this._pendingPersist;
    if (this._pendingApoWrite) await this._pendingApoWrite;
  }
}
