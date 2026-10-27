# BT AI Equalizer

**AI-powered real-time PC audio enhancer for Windows.** Captures the system
audio stream, processes it with a verified local DSP engine (parametric EQ,
dynamic bass, clarity, dynamics, stereo, loudness protection), and delivers the
enhanced signal to your output device — with Groq/Gemini-assisted sound
profiling on top of a fully local, offline-capable processing core.

> Built as real software: the DSP engine is verified by an automated test suite
> that measures filter responses, compressor transfer curves, limiter ceilings
> and FFT features against generated signals. Nothing in the UI is a mock.

---

## Quick start

```bash
npm install          # app dependencies
npm test             # 98 automated DSP/engine/AI/security tests
npm run build        # production renderer bundle (dist/)
npm start            # launch Electron (dev machine)
```

Windows audio (real device capture/render):

```bat
npm run build:native     :: compiles native/wasapi (requires VS Build Tools + Win SDK)
npm run pack:win         :: NSIS installer → release\BT-AI-Equalizer-Setup-1.0.0.exe
```

Without the native module the app **still runs** and everything is exercisable
through the clearly labeled *Simulation backend* (development only — the UI
states “no real audio I/O” wherever it is active). It never pretends to be
real playback.

## What it does

| Capability | Implementation |
| --- | --- |
| System audio capture | WASAPI **process-loopback** capture excluding the BT process tree (no feedback; note the original still plays — see limitations), or classic loopback + virtual cable |
| System-wide processing | Optional **APO DLL** path (Equalizer-APO-style) — `native/apo`, see docs/INSTALL-WINDOWS.md |
| DSP engine | `engine/` — RBJ biquad parametric EQ, harmonic bass enhancer, clarity/transient stage, soft-knee compressor (±2-band), M/S stereo, loudness trim, peak limiter |
| Analysis | FFT (Hann), band energies, spectral centroid/rolloff/flux, RMS/peak/crest, K-weighted loudness estimate, clip detection |
| AI providers | Official **groq-sdk** + **@google/genai**, main-process only, keys in OS credential store (`safeStorage`), live model lists, timeout/fallback/throttling |
| Adaptive control | Local rules react instantly; AI proposes at most one recommendation per configured interval; every proposal is schema-validated and clamped before touching DSP |
| Profiles | 15 profiles with real DSP settings + custom profiles (save/rename/duplicate/export/import) |
| Personalization | Local preference toggles + feedback learning (too much bass / too sharp / …) — resettable |
| Desktop integration | Tray, minimize-to-tray, global hotkeys, start-with-Windows, single instance, auto-recovery watchdog |
| Security | Context isolation, sandboxed renderer, strict IPC allowlist, CSP, no secrets in renderer/logs/repo |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Routing options, DSP graph, threading, AI pipeline, data flow |
| [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) | Native build, installer, APO registration, signing requirements |
| [docs/TESTING.md](docs/TESTING.md) | Test suite map, how to reproduce, hardware-dependent matrix |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures and fixes |
| [FINAL_REPORT.md](FINAL_REPORT.md) | What was built/verified here, artifacts, honest limitations |

## Honest limitations (summary)

1. **This development sandbox is Linux.** The Windows-only pieces (WASAPI
   native module compile, APO load, device playback, installer execution) are
   complete source + tooling but **were not compiled, installed, or audibly
   verified here**. Verify on a Windows machine per docs/TESTING.md.
2. **System-wide enhancement** truly requires one of: the APO path (needs
   admin registration and, if unsigned, test-signing or the documented
   `DisableProtectedAudioDG` override) or a virtual audio cable (third-party
   signed driver). The default Enhanced Path covers everything played by the
   system except audio from BT AI Equalizer itself (by design — excluded to
   prevent feedback). But it is a *tap*, not a reroute: the original apps'
   audio keeps playing alongside BT's processed copy, so you hear both
   (doubling/comb-filtering). The app warns about this at runtime; use the
   Virtual Cable mode for clean single-copy sound.
3. **AI keys are yours.** The app is fully usable without them (local DSP,
   profiles, and local adaptive rules always work).

## License

MIT — see LICENSE.
