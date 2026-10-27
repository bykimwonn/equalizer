# bt_wasapi — native Windows audio backend

WASAPI capture/render addon for BT AI Equalizer.

## What it does

- **Capture modes**
  - `process-loopback` (default): `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
    with `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` targeting the BT
    process tree. Captures the Windows audio mix **except our own render
    stream**, so processing + rendering to the same endpoint has **no feedback
    loop**. Requires Windows 10 build 20348+ (`audioclientactivationparams.h`).
  - `loopback`: classic endpoint loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`).
    Use together with a virtual audio cable render target.
- **Render**: shared-mode WASAPI, event-driven, to any render endpoint (or the
  system default). Both streams use a fixed float32 stereo DSP format with
  `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, so the engine converts to/from each
  endpoint's mix format.
- **DSP hand-off**: the audio thread captures one period, calls the JS
  `process(L, R)` callback synchronously through a blocking
  `Napi::ThreadSafeFunction`, then renders the processed buffers. The JS side
  runs the same `engine/` DSP core that the test suite verifies.

## Build (Windows)

Requirements: Node.js 20+, Python 3, Visual Studio 2022 Build Tools (C++
desktop workload), Windows 10/11 SDK.

```bat
npm install
npm run build:native
```

`build:native` runs `node-gyp configure build` in this directory. Output:
`build/Release/bt_wasapi.node`.

## Honest limitations

- This module can only be compiled and exercised on Windows. In the Linux CI
  sandbox used for development, the source was reviewed and the JS contract
  tested against the simulation backend; the WASAPI path itself must be
  verified on a Windows machine (see docs/TESTING.md, hardware-dependent
  tests).
- The synchronous JS DSP hand-off adds the main-loop scheduling latency to the
  buffer latency. Measured cost per block is reported live in the app
  (`DSP cost` in Overview) — never a fabricated number. For in-audio-thread
  processing without JS, use the APO path (`native/apo`).
- If `process-loopback` activation fails (older Windows), the engine falls back
  to classic loopback and reports the fallback in the error/status channel.
