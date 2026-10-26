# Testing

## Test suite map (`npm test` → `node --test tests/*.test.js`)

**98 automated tests, all executed in the development sandbox (Linux, Node 22).**

| File | What it proves | Kind |
| --- | --- | --- |
| `tests/biquad.test.js` | RBJ designs: exact peaking/shelf gains at measured frequencies, stability across parameter space, invalid params throw, time-domain output matches analytic response (±0.15 dB) | DSP |
| `tests/eq.test.js` | EQ boost measured on real sines (±0.4 dB), response composition, sample-rate change 44.1k↔48k consistency, per-band enable = true bypass, stereo independence | DSP |
| `tests/dynamics.test.js` | Compressor steady-state matches transfer curve (±0.6 dB), transparency below threshold & at ratio 1, soft-knee shape, makeup accuracy, clamp-to-bounds, limiter ceiling never exceeded on +6 dBFS input with clamps counted, limiter recovery, smoother monotonicity | DSP |
| `tests/analysis.test.js` | FFT bin/amplitude accuracy, features on known sines (RMS/peak/crest ±0.4 dB), band energy localization, centroid, clip detection, loudness monotonicity, flux on content change | DSP |
| `tests/chain.test.js` | Bypass bit-exactness, flat chain transparency, 8 dB EQ measured through full chain (±0.8 dB), limiter holds ceiling under extreme bass boost, click-free parameter steps (maxΔ bound), multiband path finite, sample-rate reconfig, width-0 mono fold, NaN/Inf guards | DSP |
| `tests/validate.test.js` | AI payload: clamping with warnings, NaN/string rejection, prototype-pollution immunity, unknown-key stripping, band-index errors isolated, proposal JSON parsing (fenced/prose/garbage), boolean strictness | AI safety |
| `tests/controller.test.js` | All 15 profiles valid & applyable, clip guard, feedback adjustments, hybrid pending/apply/reject, adaptive auto-apply, invalid proposals never applied, AI failure isolation, undo/reset, manual mode inert | Integration |
| `tests/store.test.js` | Settings persistence across instances, **keys never appear in any file**, custom profile lifecycle, feedback cap/reset, corrupt-file recovery, atomic writes under concurrency | Integration |
| `tests/ai.test.js` | Unconfigured rejection, groq path with identity, **fallback groq→gemini**, no-fallback isolation, malformed output rejection, unsafe values clamped pre-return, throttling, live-model listing, compact feature summaries (no raw audio) | Integration (mock transport) |
| `tests/ipc.test.js` | Preload allowlist ≡ main-process allowlist, no duplicates, unknown channels refused, handlers validate input and return `{ok:false}` | Security |
| `tests/engine-host.test.js` | **Honest failure** on non-Windows WASAPI start, full simulation loop: real DSP processing → telemetry, settings round-trip, bypass, diagnostics, mode persistence, clip guard in the loop | Integration |

## How to reproduce

```bash
npm install
npm test          # all suites
npm run lint      # syntax gate (JS); JSX validated by npm run build
npm run build     # renderer production build
```

## Test kinds (per project rules)

- **Automated DSP tests** — objective, signal-based, deterministic (above).
- **Simulated tests** — AI provider logic with mock transports; engine-host
  with the labeled simulation backend.
- **Hardware-dependent tests** — require a Windows machine + audio device.
  Not executed here. Checklist below.
- **Manually verified** — UI interaction in the running Electron app on
  Windows. Not executed here.

## Hardware-dependent checklist (Windows target machine)

1. `npm run build:native` succeeds; `bt_wasapi.node` loads (Devices screen
   lists real endpoints).
2. Play music in a browser/Spotify; Enhanced Path captures it — spectrum and
   meters react to real content.
3. Enable/disable processing → measurable EQ change (e.g. +6 dB @ 1 kHz A/B).
4. Render target: processed audio audible on the selected device; no feedback
   with Enhanced Path (process-loopback exclusion working).
5. Switch output devices mid-playback → recovery without crash (watchdog
   restart counter behaves).
6. 2-hour soak: memory flat (Task Manager), underruns = 0 at 256 frames.
7. AI: enter Groq/Gemini keys → Test connection (live latency + model list);
   airplane mode → playback and local rules unaffected.
8. `npm run pack:win` → install on a clean VM → app runs outside dev env;
   uninstaller removes it cleanly.
9. APO path (after signing): register, verify processing in `audiodg`
   (per-app bypass via endpoint enhancements toggle), unregister cleanly.

## Objective acceptance signals (in-app, truthful)

- Overview → “DSP cost” = measured `performance.now()` per block (not a
  claimed device latency). Block latency = blockFrames/sampleRate.
- “Limiter events” counts real clamps. “NaN guard” counts real trips.
- Backend labels: `Simulation — no real audio I/O` whenever the sim backend is
  active. WASAPI start failure surfaces the exact error, never a silent fallback.
