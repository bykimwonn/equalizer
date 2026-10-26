/**
 * Groq provider — official groq-sdk (OpenAI-compatible Chat Completions API).
 * Model IDs are NOT hardcoded as a single source of truth: listModels() queries
 * the live Groq API; the stored default is only an initial hint.
 */
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';

export function buildSystemPrompt() {
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

export function buildUserMessage(features, preferences, mode) {
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

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * Create a Groq provider instance.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {object} [opts.transport] injectable for tests: {chat, listModels}
 */
export async function createGroqProvider({ apiKey, model = GROQ_DEFAULT_MODEL, transport = null } = {}) {
  if (!transport) {
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey });
    transport = {
      async chat({ model: m, system, user, temperature = 0.3, maxTokens = 1200, timeoutMs = 20000 }) {
        const res = await client.chat.completions.create(
          {
            model: m,
            temperature,
            max_completion_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          },
          { timeout: timeoutMs }
        );
        return res.choices?.[0]?.message?.content ?? '';
      },
      async listModels() {
        const list = await client.models.list();
        return (list.data ?? []).map((m) => ({ id: m.id, label: m.id }));
      }
    };
  }

  return {
    id: 'groq',
    label: 'Groq',
    model,
    async recommend(features, preferences, mode, { timeoutMs = 20000 } = {}) {
      const text = await transport.chat({
        model,
        system: buildSystemPrompt(),
        user: buildUserMessage(features, preferences, mode),
        timeoutMs
      });
      return text;
    },
    async testConnection() {
      const models = await transport.listModels();
      const text = await transport.chat({
        model,
        system: 'Reply with the single word OK.',
        user: 'ping',
        maxTokens: 8,
        timeoutMs: 15000
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
