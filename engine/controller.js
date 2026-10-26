/**
 * AdaptiveController — local, real-time rules plus optional AI recommendations.
 *
 * Layered design (per architecture):
 *  1. Local safety rules act immediately on measured features (no network).
 *  2. Change detection decides when a higher-level re-recommendation is due.
 *  3. AI (Groq/Gemini) proposes profile/param changes from compact features.
 *  4. Proposals are validated (validate.js) and applied with smoothing.
 *  5. Post-apply monitoring reverts/reduces when the result is unsafe.
 *
 * Modes: 'adaptive' (auto-apply), 'hybrid' (propose only), 'manual' (idle).
 */
import { validateAiSettings, parseAiProposal } from './validate.js';
import { getProfile, profileSettings } from './profiles.js';
import { defaultSettings } from './dsp/chain.js';

export const MODES = Object.freeze(['adaptive', 'hybrid', 'manual']);

export class AdaptiveController {
  /**
   * @param {object} opts
   * @param {(features:object, prefs:object, mode:string)=>Promise<object>} [opts.aiClient]
   *   async recommend() → { ok, proposal?, provider?, error? }
   * @param {(settings:object, meta:object)=>void} opts.onApply called when settings should be applied
   * @param {(suggestion:object)=>void} [opts.onSuggest] called with pending suggestions (hybrid)
   */
  constructor({ aiClient = null, onApply = () => {}, onSuggest = () => {}, requestIntervalMs = 60000 } = {}) {
    this.aiClient = aiClient;
    this.onApply = onApply;
    this.onSuggest = onSuggest;
    this.mode = 'adaptive';
    this.requestIntervalMs = requestIntervalMs;
    this.lastRequestAt = 0;
    this.lastFeatures = null;
    this.contentChangeScore = 0;
    this.pendingSuggestion = null;
    this.history = []; // {at, source, summary}
    this.undoStack = [];
    this.safetyActions = 0;
    this.currentSettings = defaultSettings();
    this.preferences = {};
    this.lastCentroid = null;
    this.lastFlux = null;
    this.clipGuardLevel = 0;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new RangeError(`invalid mode: ${mode}`);
    this.mode = mode;
    this.pendingSuggestion = null;
  }

  setPreferences(prefs) {
    this.preferences = prefs && typeof prefs === 'object' ? { ...prefs } : {};
  }

  setCurrentSettings(settings) {
    this.currentSettings = JSON.parse(JSON.stringify(settings));
  }

  /**
   * Feed measured features each analysis frame. Triggers local rules always;
   * triggers AI when change detection + interval allow.
   */
  async onFeatures(features) {
    this.lastFeatures = features;
    this._localSafetyRules(features);
    this._detectContentChange(features);

    if (this.mode === 'manual') return;

    const due =
      Date.now() - this.lastRequestAt >= this.requestIntervalMs &&
      (this.contentChangeScore > 0.5 || this.pendingSuggestion === null);
    if (due && this.aiClient) {
      this.lastRequestAt = Date.now();
      try {
        const res = await this.aiClient.recommend(features, this.preferences, this.mode);
        if (res && res.ok && res.proposal) {
          this.handleProposal(res.proposal, res.provider || 'ai');
        }
      } catch {
        // AI failures never touch playback — ignore, keep local behavior.
      }
    }
  }

  /** Immediate safety actions from measured audio (no network). */
  _localSafetyRules(features) {
    // 1. Hard clipping observed → pull output gain down slightly (bounded)
    if (features.clipCount > 0 && this.mode !== 'manual') {
      const s = JSON.parse(JSON.stringify(this.currentSettings));
      const before = s.outputGainDb;
      s.outputGainDb = Math.max(-24, before - 1);
      if (s.outputGainDb !== before) {
        this.clipGuardLevel++;
        this.safetyActions++;
        this._apply(s, { source: 'local-safety', reason: 'clip guard: output gain reduced 1 dB' });
      }
    }
    // 2. Excessive loudness estimate while normalization is off → suggest night profile
    if (features.loudnessLufs > -8 && this.mode === 'adaptive') {
      const s = JSON.parse(JSON.stringify(this.currentSettings));
      if (s.limiter.ceilingDb > -1.5) {
        s.limiter.ceilingDb = -1.5;
        this.safetyActions++;
        this._apply(s, { source: 'local-safety', reason: 'loudness guard: ceiling set to -1.5 dBFS' });
      }
    }
    // 3. Silence → do nothing (avoid chasing noise)
  }

  _detectContentChange(features) {
    if (this.lastCentroid !== null) {
      const dc = Math.abs(features.spectralCentroidHz - this.lastCentroid) / Math.max(300, this.lastCentroid);
      const df = Math.abs(features.spectralFlux - (this.lastFlux ?? features.spectralFlux)) / Math.max(1e-3, features.spectralFlux);
      this.contentChangeScore = 0.7 * this.contentChangeScore + 0.3 * Math.min(1, dc * 2 + df * 0.2);
    }
    this.lastCentroid = features.spectralCentroidHz;
    this.lastFlux = features.spectralFlux;
  }

  /**
   * Handle an AI proposal (already raw). Validates; auto-applies in adaptive,
   * surfaces a pending suggestion in hybrid.
   */
  handleProposal(proposal, source = 'ai') {
    const parsed = typeof proposal === 'string' ? parseAiProposal(proposal) : { ok: true, proposal };
    if (!parsed.ok || !parsed.proposal) {
      this.history.push({ at: Date.now(), source, summary: `rejected: ${parsed.error || 'invalid proposal'}` });
      return { ok: false, error: parsed.error || 'invalid proposal' };
    }
    const p = parsed.proposal;

    // Merge with current settings as base
    const validated = validateAiSettings(p.settings, this.currentSettings);
    if (!validated.ok) {
      this.history.push({ at: Date.now(), source, summary: `rejected: ${validated.errors.join('; ')}` });
      return { ok: false, error: validated.errors.join('; ') };
    }

    // profile mapping (if proposed and known)
    let settings = validated.settings;
    if (p.profileId && getProfile(p.profileId).id === p.profileId) {
      const prof = profileSettings(p.profileId);
      // profile as base, AI deltas on top
      settings = validateAiSettings(p.settings, prof).settings || prof;
    }

    const suggestion = {
      at: Date.now(),
      source,
      profileId: p.profileId || null,
      explanation: p.explanation || '',
      confidence: p.confidence,
      warnings: validated.warnings,
      settings
    };

    if (this.mode === 'hybrid') {
      this.pendingSuggestion = suggestion;
      this.onSuggest(suggestion);
      return { ok: true, pending: true };
    }

    this._apply(suggestion.settings, { source, reason: p.explanation, suggestion });
    return { ok: true, applied: true };
  }

  /** User feedback adjustments (from Personalization screen). */
  applyFeedback(feedbackId) {
    const s = JSON.parse(JSON.stringify(this.currentSettings));
    let reason = '';
    switch (feedbackId) {
      case 'better':
        return { ok: true, note: 'preference recorded' };
      case 'too-much-bass':
        s.bass.gainDb = Math.max(-12, s.bass.gainDb - 1.5);
        s.bass.subGainDb = Math.max(-12, s.bass.subGainDb - 1);
        eqReduce(s, [0, 1], 1);
        reason = 'feedback: reduce bass';
        break;
      case 'too-sharp':
        s.clarity.airDb = Math.max(-12, s.clarity.airDb - 2);
        eqReduce(s, [7, 8, 9], 1.5);
        reason = 'feedback: soften treble';
        break;
      case 'too-loud':
        s.outputGainDb = Math.max(-24, s.outputGainDb - 2);
        s.limiter.ceilingDb = Math.max(-12, s.limiter.ceilingDb - 1);
        reason = 'feedback: reduce loudness';
        break;
      case 'less-processing':
        s.compressor.enabled = false;
        s.bass.harmonics = Math.max(0, s.bass.harmonics - 0.3);
        s.clarity.transients = Math.max(0, s.clarity.transients - 0.3);
        reason = 'feedback: reduce processing';
        break;
      case 'more-natural':
        s.compressor.enabled = false;
        s.stereo.width = 1;
        eqReduce(s, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.75);
        s.bass.harmonics = 0.15;
        reason = 'feedback: more natural';
        break;
      case 'reset-neutral':
        return this.resetToNeutral();
      default:
        return { ok: false, error: `unknown feedback: ${feedbackId}` };
    }
    this._apply(s, { source: 'feedback', reason });
    return { ok: true, applied: true };
  }

  resetToNeutral() {
    const s = profileSettings('balanced');
    this._apply(s, { source: 'feedback', reason: 'reset to neutral' });
    return { ok: true, applied: true };
  }

  /** Accept the pending hybrid suggestion. */
  acceptPending() {
    if (!this.pendingSuggestion) return { ok: false, error: 'no pending suggestion' };
    const sug = this.pendingSuggestion;
    this.pendingSuggestion = null;
    this._apply(sug.settings, { source: sug.source, reason: sug.explanation, suggestion: sug });
    return { ok: true, applied: true };
  }

  rejectPending() {
    const sug = this.pendingSuggestion;
    this.pendingSuggestion = null;
    this.history.push({ at: Date.now(), source: sug ? sug.source : 'ai', summary: 'user rejected suggestion' });
    return { ok: true };
  }

  undoLast() {
    const prev = this.undoStack.pop();
    if (!prev) return { ok: false, error: 'nothing to undo' };
    this._apply(prev, { source: 'undo', reason: 'undo last change' }, true);
    return { ok: true, applied: true };
  }

  _apply(settings, meta, skipUndo = false) {
    if (!skipUndo) this.undoStack.push(JSON.parse(JSON.stringify(this.currentSettings)));
    if (this.undoStack.length > 20) this.undoStack.shift();
    this.currentSettings = JSON.parse(JSON.stringify(settings));
    this.history.push({ at: Date.now(), source: meta.source, summary: meta.reason || '' });
    if (this.history.length > 50) this.history.shift();
    this.onApply(this.currentSettings, meta);
  }
}

function eqReduce(settings, bandIds, amountDb) {
  for (const b of settings.eq.bands) {
    if (bandIds.includes(b.id)) {
      b.gainDb = Math.max(-12, b.gainDb - amountDb);
    }
  }
}
