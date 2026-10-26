/**
 * Google Gemini provider — official @google/genai SDK.
 * Model IDs are NOT hardcoded as a single source of truth: listModels() queries
 * the live Gemini API; the stored default is only an initial hint.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export function buildSystemPrompt() {
  // shared contract with Groq — kept identical so providers are interchangeable
  return [
    'You are the sound-profile engine of a local PC audio equalizer.',
    'You receive compact non-sensitive audio features (levels, band energies, spectral statistics).',
    'You NEVER receive raw audio. Propose DSP changes within the documented schema only.',
    'Respond with STRICT JSON only, no markdown, matching:',
    '{"profileId": "<one of: balanced, bass-boost, deep-bass, vocal-clarity, acoustic, classical, rock, hip-hop, electronic, jazz, podcast, gaming, movie, night | null>',
    ' "explanation": "<short user-facing rationale>",',
    ' "confidence": 0.0-1.0,',
    ' "settings": { "eq": {"bands":[{"id":0-9,"gainDb":-12..12,"q":0.1..10,"freq":20..20000}]},',
    '   "bass": {"gainDb":-12..12,"subGainDb":-12..12,"harmonics":0..1},',
    '   "clarity": {"presenceDb":-12..12,"airDb":-12..12,"transients":0..1},',
    '   "compressor": {"enabled":bool,"thresholdDb":-60..0,"ratio":1..20,"attackMs":0.1..200,"releaseMs":5..2000,"kneeDb":0..24,"makeupDb":-12..12,"multiband":bool},',
    '   "limiter": {"ceilingDb":-12..-0.5},',
    '   "stereo": {"width":0..2,"balance":-1..1},',
    '   "loudness": {"normalization":bool,"targetLufs":-31..-5},',
    '   "outputGainDb": -24..24 } }',
    'All values are numbers (never strings). Omit fields you do not want to change.',
    'Do not claim to identify genre or instruments with certainty; confidence must reflect uncertainty.',
    'Prefer small, musical adjustments over aggressive settings.'
  ].join('\n');
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function buildUserMessage(features, preferences, mode) {
  return JSON.stringify({
    task: 'recommend-dsp-settings',
    mode,
    preferences,
    features: {
      rmsDb: round(features.rmsDb),
      peakDb: round(features.peakDb),
      crestDb: round(features.crestDb),
      loudnessLufs: round(features.loudnessLufs),
      bandEnergiesDb: (features.bandEnergiesDb || []).map(round),
      spectralCentroidHz: round(features.spectralCentroidHz),
      rolloff85Hz: round(features.rolloff85Hz),
      spectralFlux: round(features.spectralFlux),
      clipCount: features.clipCount | 0
    }
  });
}

/**
 * Create a Gemini provider instance.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {object} [opts.transport] injectable for tests
 */
export async function createGeminiProvider({ apiKey, model = GEMINI_DEFAULT_MODEL, transport = null } = {}) {
  if (!transport) {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey });
    transport = {
      async chat({ model: m, system, user, temperature = 0.3, maxTokens = 1200 }) {
        const res = await client.models.generateContent({
          model: m,
          contents: user,
          config: {
            systemInstruction: system,
            temperature,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json'
          }
        });
        return res.text ?? '';
      },
      async listModels() {
        const out = [];
        const pager = await client.models.list();
        for await (const m of pager) {
          const id = m.name?.replace(/^models\//, '');
          if (id && (m.supportedGenerationMethods ?? []).includes('generateContent')) {
            out.push({ id, label: id });
          } else if (id && !m.supportedGenerationMethods) {
            out.push({ id, label: id });
          }
        }
        return out;
      }
    };
  }

  return {
    id: 'gemini',
    label: 'Google Gemini',
    model,
    async recommend(features, preferences, mode, { timeoutMs = 25000 } = {}) {
      return transport.chat({
        model,
        system: buildSystemPrompt(),
        user: buildUserMessage(features, preferences, mode),
        timeoutMs
      });
    },
    async testConnection() {
      const models = await transport.listModels();
      const text = await transport.chat({
        model,
        system: 'Reply with the single word OK.',
        user: 'ping',
        maxTokens: 8
      });
      return { ok: true, modelCount: models.length, reply: String(text).slice(0, 32), models: models.slice(0, 50) };
    },
    async listModels() {
      return transport.listModels();
    },
    setModel(m) {
      model = m;
      this.model = m;
    }
  };
}
