# bt-ai-eq-apo — system-wide Windows APO

User-mode **Audio Processing Object** that the Windows audio engine
(`audiodg.exe`) loads on a render endpoint's FX chain. This is the true
*system-wide* processing path: every application playing to that endpoint is
enhanced — browser, Spotify, games, everything — with no virtual cable and no
per-app capture.

## Why an APO (and not a kernel driver)

Windows supports user-mode APOs as the sanctioned plug-in point for output
processing. Equalizer APO, many OEM "audio enhancements", and Dolby-style
effects use this mechanism. It needs **no kernel driver**, but it does need:

1. **Registration** (admin): COM CLSID + endpoint `FxProperties` chain entry
   (`register-apo.ps1` performs exactly these documented steps).
2. **A signature**: `audiodg.exe` only loads APOs that are signed (or on
   test-signed machines / with the documented `DisableProtectedAudioDG`
   override — see the script's output for the exact, reversible commands).

**This build does not ship a signed DLL and the registration script has not
been executed on any machine.** Building and verifying the APO requires
Windows + MSVC; see docs/INSTALL-WINDOWS.md for the precise status and next
steps.

## Contents

| File | Purpose |
| --- | --- |
| `apo_dsp.h` | Allocation-free C++ DSP (10-band EQ, gains, limiter) used inside `APOProcess` |
| `bt_apo.cpp` | COM APO implementation (`IAudioProcessingObject`, `...RT`, `...Controls`) |
| `register-apo.ps1` | Admin registration/unregistration (explicit, reversible, no silent policy changes) |
| `bin/` | Build output (`bt-ai-eq-apo.dll`) after you compile on Windows |

## Build (Windows)

```bat
cl /LD /std:c++17 /EHsc bt_apo.cpp /link /DLL /OUT:bin\bt-ai-eq-apo.dll ole32.lib uuid.lib
```

(or open the sources in a VS "Empty Project" with Dynamic Library target).

## Runtime configuration

The APO polls `%ProgramData%\BT-AI-Equalizer\apo-config.bin` (a small binary
snapshot of the DSP parameters) written by the BT AI Equalizer app. The
real-time `APOProcess` never opens files or takes locks — it copies the
payload only when the atomic version counter changes.

## Honest limitations

- Unsigned DLL ⇒ won't load in `audiodg.exe` on a normal machine. Release
  builds must be code-signed (EV recommended). This is a **genuine external
  blocker** (requires a signing certificate), not something this repository
  can fabricate.
- The APO implements the EQ/gain/limiter subset of the app's DSP. Full
  feature parity (harmonic bass, multiband compressor, stereo width) would
  move more of `engine/` into `apo_dsp.h`; the parameter format is designed
  so that can be added without changing registration.
- Nothing here was installed or audibly verified in the development sandbox
  (Linux). Treat it as complete source + tooling pending a Windows test pass.
