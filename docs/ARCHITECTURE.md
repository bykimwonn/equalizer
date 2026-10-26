# Architecture

## 1. System overview

```
┌────────────────────────────── Windows ───────────────────────────────┐
│  Apps: browser, Spotify, games, players …                            │
│        │  render streams                                            │
│        ▼                                                             │
│  Windows audio engine (audiodg.exe / audio endpoint mixer)           │
│        │                                                             │
│   ┌────┴───────────────┐        ┌──────────────────────────────┐    │
│   │ WASAPI process-    │        │ (optional) BT APO DLL        │    │
│   │ loopback capture   │        │ in audiodg — system-wide FX  │    │
│   │ (excl. BT process) │        └──────────────────────────────┘    │
│   └────┬───────────────┘                                            │
│        │ PCM (float32, deinterleaved L/R)                           │
│        ▼                                                             │
│   bt_wasapi.node ──► Electron main process                          │
│                      ┌───────────────────────────────┐              │
│                      │ AudioEngine (engine/engine.js)│              │
│                      │  ├ DspChain  (engine/dsp/*)   │              │
│                      │  └ FeatureExtractor (FFT…)    │              │
│                      │  └ AdaptiveController         │              │
│                      └──────────────┬────────────────┘              │
│        processed PCM ◄──────────────┘                               │
│        │                                                             │
│        ▼                                                             │
│   WASAPI render ──► selected output device                           │
└──────────────────────────────────────────────────────────────────────┘
                 ▲ compact feature summaries (JSON) ▲
                 │                                 │
        Groq API (groq-sdk)             Gemini API (@google/genai)
        — main process only —           — keys in safeStorage —
```

## 2. Routing architectures (what actually replaces system audio)

WASAPI loopback capture **alone does not re-route audio** — captured audio must
be re-rendered somewhere, and rendering back into the same endpoint you loop
from creates feedback. BT AI Equalizer implements three honest modes:

### Mode A — Enhanced Path (default, no driver)
`audio.routingMode = process-loopback`

- Capture: `ActivateAudioInterfaceAsync` +
  `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` +
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` (Windows 10 2004+),
  targeting the BT process tree. The capture therefore contains the system mix
  **minus BT's own render stream** → processing + rendering to the same
  endpoint is feedback-free by construction.
- Scope: everything played by the system except the app's own audio.
- Fallback: classic loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`) with an explicit
  status warning when activation fails.

### Mode B — Virtual Cable Routing
`audio.routingMode = loopback-to-cable`

- Classic endpoint loopback → DSP → render to a virtual cable (VB-CABLE or
  equivalent, third-party signed driver). The user sets the cable as the
  default playback device. This is a true system-wide path but requires the
  cable driver to be installed — **we never install or silently change your
  default device**.

### Mode C — APO (true system-wide, in audiodg)
`audio.routingMode = apo` + `native/apo`

- A user-mode **Audio Processing Object** loaded by the Windows audio engine on
  the endpoint's FX chain (the Equalizer APO mechanism). Every application's
  final mix is processed inside `audiodg.exe`.
- Requires: DLL build (MSVC), registration (admin), and **code signing** — or
  test-signing / the documented `DisableProtectedAudioDG` override for
  unsigned builds. See docs/INSTALL-WINDOWS.md.
- The APO's C++ DSP (EQ, gain, limiter subset) runs allocation-free in
  `APOProcess`; configuration is passed via an atomically-versioned memory
  file — never file I/O on the audio thread.

## 3. DSP chain (`engine/dsp/chain.js`)

```
input gain ─► parametric EQ (10× RBJ biquads) ─► bass enhancer ─► clarity ─►
dynamics (1-band or 2-band LR4 crossover + two compressors) ─► M/S stereo ─►
loudness trim (slow, bounded, optional) ─► output gain ─► peak limiter + counted safety clamp
```

- **Biquads** — RBJ Audio EQ Cookbook, normalized, stability-checked
  (`|a2| < 1 ∧ |a1| < 1 + a2`). Invalid parameters throw before design.
- **Smoothing** — every scalar gain goes through a per-sample one-pole
  `ParamSmoother`; filter coefficients update at block boundaries only when
  parameters change. Verified click-free in tests.
- **Bass enhancer** — low-shelf + sub-shelf + optional harmonic path
  (band-limited low signal → tanh waveshaping → band-limited harmonics),
  soft-capped; never claims to reconstruct absent information.
- **Compressor** — feed-forward, soft knee (quadratic), attack/release
  envelope on the detector dB, stereo-linked; multiband splits at a 4th-order
  LR crossover with a 6 dB more sensitive low-band threshold.
- **Limiter** — envelope gain toward the ceiling (fast attack / slow release),
  plus a sample-accurate clamp that is **counted and surfaced** (never silent).
- **Bypass** — bit-exact pass-through (samples untouched), used for A/B.

The UI response curve (`src/curve.js`) evaluates **the same coefficient
math** (`magnitudeAt`) — the curve is the filter response, not an illustration.

## 4. Analysis (`engine/analysis/`)

- Radix-2 FFT (2048, Hann, 50% overlap, coherent-gain compensated).
- Features per frame: 8 band energies (20 Hz–20 kHz), spectral centroid,
  85% rolloff, half-wave spectral flux, RMS/peak/crest, K-weighted mean-square
  loudness estimate (BS.1770-style shelving + 38 Hz high-pass), DC offset,
  clip counter.
- Spectrum snapshot: 64 log bands for the UI — computed from the same FFT data.

## 5. Adaptive controller (`engine/controller.js`)

Layered, per the requirement that local behavior never waits for the cloud:

1. **Local safety rules** (immediate, on measured features): clip guard
   (−1 dB output steps), loudness guard (ceiling cap), silence ignore.
2. **Change detection**: normalized centroid/flux deltas accumulate a
   content-change score.
3. **AI request** (optional): at most once per `requestIntervalMs`, only when
   allowed; throttled; **failures never touch playback**.
4. **Validation**: `engine/validate.js` — allowlisted numeric/boolean schema,
   finite-number checks, bounds clamped with warnings, unknown keys discarded
   (no instruction-following payloads can reach the DSP).
5. **Apply** with smoothing; **undo stack** (20 deep) for every change.
6. Modes: `adaptive` (auto-apply), `hybrid` (propose → user approves),
   `manual` (controller idle).

## 6. AI providers (`electron/ai/`)

- **Transport**: official SDKs (`groq-sdk`, `@google/genai`) behind an
  injectable `transport` interface (tests run with mock transports).
- **Model IDs are not hardcoded as truth**: defaults are initial hints
  (`openai/gpt-oss-20b`, `gemini-3.8-flash`); `listModels()` queries the live
  provider APIs and the UI lets the user pick the current model.
- **Prompt contract**: strict JSON proposal (profileId, explanation,
  confidence, settings) — parsed tolerantly, validated strictly.
- **Secrets**: `SettingsStore` stores API keys only via the injected cryptor
  (`safeStorage` → OS credential store; AES-256-GCM machine-key fallback is
  labeled in the UI). Tests assert keys never appear in any config file.
- **Privacy**: only compact numeric feature summaries leave the machine —
  never raw audio (and only when a request is actually due).

## 7. Electron security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webviewTag: false`.
- Preload (`electron/preload.cjs`) exposes `window.bt.invoke/on` with a hard
  channel allowlist mirrored by `electron/ipc.js` (a unit test asserts the two
  lists stay identical).
- CSP: `default-src 'self'`, no remote script, no eval.
- Navigation is disabled; external links open in the system browser.
- IPC handlers validate input shapes and return `{ok:false,error}` — they do
  not throw across the boundary.

## 8. Threading & real-time safety

- The DSP core processes blocks on the native audio thread callback (main-
  process event loop via blocking ThreadSafeFunction hand-off).
- No network, disk, allocation, or locking in the sample loop. Parameter
  changes are applied between blocks.
- Telemetry pushes at 30 Hz; the renderer throttles React updates to 20 Hz.
- A watchdog restarts stalled streams with status `recovering` and counts
  restarts truthfully.

## 9. Persistence

`%APPDATA%/BT AI Equalizer/config/` (Electron `userData`):

| File | Content |
| --- | --- |
| `app-config.json` | modes, AI prefs, audio devices, UI/hotkey settings |
| `profiles.json` | active DSP settings + custom profiles |
| `personalization.json` | preferences + feedback history (capped) |
| `credentials.json` | **encrypted blobs only** (safeStorage / AES-GCM) |

Atomic writes (unique tmp + rename) — crash-safe, concurrency-safe.
