/**
 * AI manager — provider lifecycle, selection, fallback, timeouts, throttling.
 *
 * Hard rules enforced here:
 *  - Raw audio never leaves the machine; only compact feature summaries.
 *  - Every response is parsed + validated (engine/validate.js) before it can
 *    reach the DSP chain. A failed request never touches playback.
 *  - Requests are throttled by interval and (optionally) content-change score.
 */
import { parseAiProposal, validateAiSettings } from '../../engine/validate.js';
import { createGroqProvider, GROQ_DEFAULT_MODEL } from './groq.js';
import { createGeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini.js';

export class AiManager {
  /**
   * @param {object} opts
   * @param {SettingsStore} opts.settingsStore
   * @param {(name:'groq'|'gemini')=>Promise<object|null>} [opts.providerFactory] injectable for tests
   */
  constructor({ settingsStore, providerFactory = null }) {
    this.settingsStore = settingsStore;
    this.providerFactory = providerFactory ?? defaultProviderFactory;
    this.providers = new Map();
    this.status = {
      groq: { configured: false, lastError: null, lastOkAt: null, lastLatencyMs: null },
      gemini: { configured: false, lastError: null, lastOkAt: null, lastLatencyMs: null },
      lastProviderUsed: null
    };
    this.lastRequestAt = 0;
  }

  async _ensureProvider(name) {
    const app = await this.settingsStore.getAppSettings();
    const cfg = name === 'groq' ? app.ai.groq : app.ai.gemini;
    const apiKey = await this.settingsStore.getApiKey(name);
    if (!apiKey) {
      this.status[name].configured = false;
      return null;
    }
    this.status[name].configured = true;
    const cached = this.providers.get(name);
    if (cached && cached.model === cfg.model && cached._keyFingerprint === fingerprint(apiKey)) {
      return cached;
    }
    const provider = await this.providerFactory(name, {
      apiKey,
      model: cfg.model || (name === 'groq' ? GROQ_DEFAULT_MODEL : GEMINI_DEFAULT_MODEL)
    });
    provider._keyFingerprint = fingerprint(apiKey);
    this.providers.set(name, provider);
    return provider;
  }

  /** Live model list from the provider (never a hardcoded stale list). */
  async listModels(name) {
    const provider = await this._ensureProvider(name);
    if (!provider) return { ok: false, error: `${name} is not configured`, models: [] };
    try {
      const models = await provider.listModels();
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e), models: [] };
    }
  }

  async testConnection(name) {
    const provider = await this._ensureProvider(name);
    if (!provider) return { ok: false, error: `${name} is not configured (add an API key first)` };
    const t0 = Date.now();
    try {
      const res = await provider.testConnection();
      this.status[name].lastOkAt = Date.now();
      this.status[name].lastLatencyMs = Date.now() - t0;
      this.status[name].lastError = null;
      return { ok: true, latencyMs: Date.now() - t0, ...res };
    } catch (e) {
      this.status[name].lastError = String(e.message ?? e);
      return { ok: false, error: this.status[name].lastError };
    }
  }

  _order() {
    return this.settingsStore.getAppSettings().then((app) => {
      const pref = app.ai.provider;
      const names = pref === 'groq' ? ['groq', 'gemini'] : pref === 'gemini' ? ['gemini', 'groq'] : ['groq', 'gemini'];
      return app.ai.fallback ? names : names.slice(0, 1);
    });
  }

  /**
   * Request a recommendation. Returns a validated proposal or an error —
   * never throws.
   * @returns {{ok:boolean, proposal?:object, provider?:string, validated?:object, warnings?:string[], error?:string, latencyMs?:number, throttled?:boolean}}
   */
  async recommend(features, preferences, mode, { force = false } = {}) {
    const app = await this.settingsStore.getAppSettings();
    const interval = Math.max(5000, app.ai.requestIntervalMs | 0);
    const now = Date.now();
    if (!force && now - this.lastRequestAt < interval) {
      return { ok: false, throttled: true, error: `throttled: min interval ${interval} ms` };
    }
    this.lastRequestAt = now;

    const order = await this._order();
    const errors = [];
    for (const name of order) {
      const provider = await this._ensureProvider(name);
      if (!provider) {
        errors.push(`${name}: not configured`);
        continue;
      }
      const t0 = Date.now();
      try {
        const text = await provider.recommend(features, preferences, mode);
        const latencyMs = Date.now() - t0;
        this.status[name].lastOkAt = Date.now();
        this.status[name].lastLatencyMs = latencyMs;
        this.status[name].lastError = null;
        this.status.lastProviderUsed = name;

        const parsed = parseAiProposal(text);
        if (!parsed.ok) {
          errors.push(`${name}: ${parsed.error}`);
          continue;
        }
        const validated = validateAiSettings(parsed.proposal.settings, await this.settingsStore.getDspSettings());
        if (!validated.ok) {
          errors.push(`${name}: proposal rejected — ${validated.errors.join('; ')}`);
          continue;
        }
        return {
          ok: true,
          provider: name,
          latencyMs,
          proposal: parsed.proposal,
          validated,
          warnings: validated.warnings
        };
      } catch (e) {
        const msg = String(e.message ?? e);
        this.status[name].lastError = msg;
        errors.push(`${name}: ${msg}`);
      }
    }
    return { ok: false, error: errors.join(' | ') || 'no provider available' };
  }

  getStatus() {
    return JSON.parse(JSON.stringify(this.status));
  }

  /** Invalidate cached SDK clients (after key change/clear). */
  invalidate(name = null) {
    if (name) this.providers.delete(name);
    else this.providers.clear();
  }
}

function fingerprint(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `fp${(h >>> 0).toString(16)}`;
}

async function defaultProviderFactory(name, { apiKey, model }) {
  if (name === 'groq') return createGroqProvider({ apiKey, model });
  if (name === 'gemini') return createGeminiProvider({ apiKey, model });
  throw new RangeError(`unknown provider ${name}`);
}
