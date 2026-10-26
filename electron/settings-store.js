/**
 * Persistent configuration store.
 *
 * - JSON files under a caller-provided config dir (Electron: userData/config).
 * - API keys are stored ONLY through the injected cryptor (Electron: safeStorage
 *   → OS credential store backed encryption). They never appear in plain JSON,
 *   logs, or the renderer.
 * - Atomic writes (tmp + rename) to survive crashes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultSettings } from '../engine/dsp/chain.js';
import { PROFILES, profileSettings } from '../engine/profiles.js';

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._cache = null;
    // serialize writes per store: prevents tmp/rename races on Windows and
    // makes read-modify-write updates atomic
    this._queue = Promise.resolve();
  }

  async read() {
    if (this._cache !== null) return this._cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this._cache = JSON.parse(raw);
    } catch {
      this._cache = null;
    }
    return this._cache;
  }

  async write(obj) {
    this._cache = obj;
    const task = this._queue.then(() => this._writeAtomic(obj));
    this._queue = task.catch(() => {});
    return task;
  }

  async _writeAtomic(obj) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // unique tmp name per write — concurrent writes must not collide
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try {
      await renameWithRetry(tmp, this.filePath);
    } catch (e) {
      // last resort (Windows AV interference): copy-over then remove tmp
      try {
        await fs.copyFile(tmp, this.filePath);
        await fs.unlink(tmp).catch(() => {});
      } catch {
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
    }
  }

  async update(fn) {
    const task = this._queue.then(async () => {
      const cur = (await this.read()) ?? {};
      const next = fn(cur) ?? cur;
      await this._writeAtomic(next);
      this._cache = next;
      return next;
    });
    this._queue = task.catch(() => {});
    return task;
  }

  invalidate() {
    this._cache = null;
  }
}

/**
 * Windows-safe rename: the destination can be momentarily locked by a
 * concurrent rename or by antivirus/indexer scanning the fresh tmp file.
 * Retry transient errors, then let the caller fall back.
 */
async function renameWithRetry(from, to, attempts = 6) {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'ENOTEMPTY']);
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (i >= attempts - 1 || !transient.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}

/** Machine-key AES fallback cryptor when OS keychain is unavailable. */
export function machineKeyCryptor(configDir) {
  const keyFile = path.join(configDir, '.machine.key');
  let key = null;
  const loadKey = async () => {
    if (key) return key;
    try {
      key = Buffer.from(await fs.readFile(keyFile, 'utf8'), 'hex');
    } catch {
      key = crypto.randomBytes(32);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(keyFile, key.toString('hex'), { mode: 0o600 });
    }
    return key;
  };
  return {
    id: 'machineKey',
    label: 'encrypted file (machine key)',
    async encryptString(plain) {
      const k = await loadKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    async decryptString(blob) {
      const k = await loadKey();
      const b = Buffer.from(blob);
      const iv = b.subarray(0, 12);
      const tag = b.subarray(12, 28);
      const enc = b.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    }
  };
}

const DEFAULT_APP_SETTINGS = Object.freeze({
  version: 1,
  mode: 'adaptive', // adaptive | hybrid | manual
  activeProfileId: 'balanced',
  ai: {
    provider: 'auto', // groq | gemini | auto
    fallback: true,
    requestIntervalMs: 60000,
    onlyOnContentChange: true,
    groq: { model: 'openai/gpt-oss-20b', enabled: false },
    gemini: { model: 'gemini-3.8-flash', enabled: false }
  },
  audio: {
    backend: 'wasapi', // wasapi | simulation
    captureDeviceId: 'default',
    renderDeviceId: 'default',
    blockFrames: 256,
    sampleRate: 48000,
    routingMode: 'process-loopback' // process-loopback | loopback-to-cable | apo
  },
  ui: {
    theme: 'midnight',
    minimizeToTray: true,
    startWithWindows: false,
    showAdvancedEq: true
  },
  hotkeys: {
    toggleProcessing: 'CommandOrControl+Shift+E',
    toggleMode: 'CommandOrControl+Shift+M',
    profileNext: 'CommandOrControl+Shift+P'
  }
});

export class SettingsStore {
  /**
   * @param {string} configDir directory for persistent state
   * @param {object} cryptor {id,label,encryptString,decryptString} (safeStorage adapter)
   */
  constructor(configDir, cryptor) {
    this.configDir = configDir;
    this.cryptor = cryptor;
    this.settingsStore = new JsonStore(path.join(configDir, 'app-config.json'));
    this.profilesStore = new JsonStore(path.join(configDir, 'profiles.json'));
    this.personalStore = new JsonStore(path.join(configDir, 'personalization.json'));
    this.credStore = new JsonStore(path.join(configDir, 'credentials.json'));
  }

  async init() {
    await fs.mkdir(this.configDir, { recursive: true });
    const s = await this.settingsStore.read();
    if (!s) await this.settingsStore.write(DEFAULT_APP_SETTINGS);
    return this.getAppSettings();
  }

  async getAppSettings() {
    const s = (await this.settingsStore.read()) ?? DEFAULT_APP_SETTINGS;
    // shallow-merge with defaults so upgrades never lose keys
    return {
      ...DEFAULT_APP_SETTINGS,
      ...s,
      ai: { ...DEFAULT_APP_SETTINGS.ai, ...(s.ai ?? {}), groq: { ...DEFAULT_APP_SETTINGS.ai.groq, ...(s.ai?.groq ?? {}) }, gemini: { ...DEFAULT_APP_SETTINGS.ai.gemini, ...(s.ai?.gemini ?? {}) } },
      audio: { ...DEFAULT_APP_SETTINGS.audio, ...(s.audio ?? {}) },
      ui: { ...DEFAULT_APP_SETTINGS.ui, ...(s.ui ?? {}) },
      hotkeys: { ...DEFAULT_APP_SETTINGS.hotkeys, ...(s.hotkeys ?? {}) }
    };
  }

  async setAppSettings(patch) {
    if (!patch || typeof patch !== 'object') throw new TypeError('patch must be an object');
    return this.settingsStore.update((cur) => {
      const merged = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
          merged[k] = { ...cur[k], ...v };
        } else {
          merged[k] = v;
        }
      }
      return merged;
    });
  }

  /** DSP processing settings (the engine chain state) live with the active profile slot. */
  async getDspSettings() {
    const p = (await this.profilesStore.read()) ?? {};
    return p.activeSettings ?? profileSettings((await this.getAppSettings()).activeProfileId);
  }

  async setDspSettings(settings) {
    return this.profilesStore.update((cur) => ({ ...cur, activeSettings: settings }));
  }

  async listCustomProfiles() {
    const p = (await this.profilesStore.read()) ?? {};
    return Array.isArray(p.custom) ? p.custom : [];
  }

  async saveCustomProfile(profile) {
    if (!profile || typeof profile !== 'object' || typeof profile.name !== 'string') {
      throw new TypeError('profile must include a name');
    }
    const custom = await this.listCustomProfiles();
    const entry = {
      id: typeof profile.id === 'string' && profile.id ? profile.id : `custom-${Date.now()}`,
      name: profile.name.slice(0, 64),
      description: typeof profile.description === 'string' ? profile.description.slice(0, 256) : '',
      settings: profile.settings ?? defaultSettings(),
      updatedAt: Date.now()
    };
    const idx = custom.findIndex((c) => c.id === entry.id);
    if (idx >= 0) custom[idx] = entry;
    else custom.push(entry);
    await this.profilesStore.update((cur) => ({ ...cur, custom }));
    return entry;
  }

  async deleteCustomProfile(id) {
    const custom = (await this.listCustomProfiles()).filter((c) => c.id !== id);
    await this.profilesStore.update((cur) => ({ ...cur, custom }));
    return { ok: true };
  }

  async exportProfile(id) {
    const builtin = PROFILES.find((p) => p.id === id);
    if (builtin) return { id, name: builtin.name, description: builtin.description, settings: profileSettings(id) };
    const custom = (await this.listCustomProfiles()).find((c) => c.id === id);
    if (custom) return { id: custom.id, name: custom.name, description: custom.description, settings: custom.settings };
    return null;
  }

  async importProfile(data) {
    if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.settings) {
      throw new TypeError('invalid profile file');
    }
    return this.saveCustomProfile({
      name: data.name,
      description: typeof data.description === 'string' ? data.description : 'imported',
      settings: data.settings
    });
  }

  // ---------- personalization ----------

  async getPersonalization() {
    const p = (await this.personalStore.read()) ?? {};
    return {
      preferences: {
        strongerBass: false,
        clearerVocals: false,
        lessHarshTreble: false,
        moreDetail: false,
        naturalSound: true,
        widerStereo: false,
        softerAtNight: false,
        minimalCompression: false,
        clarityAtLowVolume: true,
        ...(p.preferences ?? {})
      },
      feedback: Array.isArray(p.feedback) ? p.feedback.slice(-200) : [],
      learnedAdjustments: p.learnedAdjustments ?? null
    };
  }

  async addFeedback(feedbackId) {
    if (typeof feedbackId !== 'string') throw new TypeError('feedbackId must be a string');
    return this.personalStore.update((cur) => {
      const feedback = Array.isArray(cur.feedback) ? cur.feedback : [];
      feedback.push({ id: feedbackId, at: Date.now() });
      return { ...cur, feedback: feedback.slice(-200) };
    });
  }

  async setPreferences(patch) {
    return this.personalStore.update((cur) => ({
      ...cur,
      preferences: { ...(cur.preferences ?? {}), ...patch }
    }));
  }

  async resetPersonalization() {
    await this.personalStore.write({ preferences: {}, feedback: [], learnedAdjustments: null });
    return { ok: true };
  }

  // ---------- credentials (NEVER stored in plain JSON) ----------

  async setApiKey(provider, apiKey) {
    if (!['groq', 'gemini'].includes(provider)) throw new TypeError('unknown provider');
    const encrypted = await this.cryptor.encryptString(String(apiKey));
    await this.credStore.update((cur) => ({
      ...cur,
      [provider]: {
        blob: Buffer.from(encrypted).toString('base64'),
        cryptor: this.cryptor.id,
        updatedAt: Date.now()
      }
    }));
    return { ok: true, storage: this.cryptor.label };
  }

  async getApiKey(provider) {
    const rec = (await this.credStore.read())?.[provider];
    if (!rec?.blob) return null;
    try {
      return await this.cryptor.decryptString(Buffer.from(rec.blob, 'base64'));
    } catch {
      return null;
    }
  }

  async clearApiKey(provider) {
    await this.credStore.update((cur) => {
      const next = { ...cur };
      delete next[provider];
      return next;
    });
    return { ok: true };
  }

  /** Non-sensitive status for the UI. */
  async credentialStatus() {
    const rec = (await this.credStore.read()) ?? {};
    return {
      groq: { configured: !!rec.groq, storage: rec.groq ? this.cryptor.label : null },
      gemini: { configured: !!rec.gemini, storage: rec.gemini ? this.cryptor.label : null }
    };
  }
}
