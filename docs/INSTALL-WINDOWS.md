# Installing BT AI Equalizer on Windows

This document is precise about what is automated, what is manual, and what
requires external artifacts (signing). **Nothing below has been executed on a
Windows machine in the development sandbox — status labels are exact.**

## 0. Requirements

| Component | Requirement |
| --- | --- |
| OS | Windows 10 2004 (build 19041)+ recommended (needed for process-loopback); Windows 11 fully supported |
| Runtime | none — the app is packaged with Electron |
| Build machine (dev) | Node 20+, Python 3, VS 2022 Build Tools (C++ workload), Windows 10/11 SDK |
| Privileges | normal user for the app; **Administrator** only for APO registration |
| Signing cert | required to load the APO in `audiodg.exe` on production machines |

## 1. Standard install (desktop app)

```bat
:: from a clean checkout
npm install
npm run build          :: renderer
npm run build:native   :: bt_wasapi.node  (Windows-only; see §2)
npm run pack:win       :: → release\BT-AI-Equalizer-Setup-1.0.0.exe
```

Run `BT-AI-Equalizer-Setup-1.0.0.exe`. The NSIS installer:

- installs per-user or per-machine (directory selectable), `asInvoker`
  (no admin required for the base app),
- adds Start Menu shortcuts + the app icon,
- can be uninstalled cleanly from “Apps & features” (NSIS uninstaller).

**Status: build scripts complete; installer has not been produced or executed
in the Linux sandbox** (`electron-builder --win` needs Windows or Wine — not
available here). First action on a Windows machine: run the three commands
above and launch the result.

## 2. Native audio module (WASAPI)

```bat
npm run build:native
```

Builds `native/wasapi/build/Release/bt_wasapi.node` via node-gyp. If the build
or load fails, the app runs with the **Simulation backend** and says so in the
UI — it will not pretend to capture real audio.

Troubleshooting: see docs/TROUBLESHOOTING.md §Native module.

## 3. Routing modes — choose deliberately

| Mode | What you get | Extra requirements |
| --- | --- | --- |
| **Enhanced Path** (default) | All system audio except BT's own output is captured (process-loopback, excl. BT process tree), enhanced, rendered to your device | Windows 10 2004+ |
| **Virtual Cable** | True system-wide loopback → DSP → virtual cable | Install e.g. VB-CABLE yourself; set cable as default playback |
| **System-wide APO** | All audio on the endpoint processed inside `audiodg.exe` | §4 |

The app **never changes your default playback device** by itself.

## 4. APO installation (system-wide) — precise status

Source: `native/apo/` (complete C++ + PowerShell registration).

1. **Build the DLL** (Windows + MSVC):
   ```bat
   cd native\apo
   cl /LD /std:c++17 /EHsc bt_apo.cpp /link /DLL /OUT:bin\bt-ai-eq-apo.dll ole32.lib uuid.lib
   ```
2. **Register** (elevated PowerShell):
   ```powershell
   .\register-apo.ps1 -DllPath .\bin\bt-ai-eq-apo.dll -ApplyToDefaultEndpoint
   ```
   This copies the DLL, registers the COM CLSID, and adds it to the endpoint's
   `FxProperties` SFX chain. Reversible: `.\register-apo.ps1 -Unregister`.
3. **Signing — the hard requirement.** Windows only loads APOs into
   `audiodg.exe` when the DLL is **signed**, or on a test-signed machine, or
   with the documented `DisableProtectedAudioDG=1` override under
   `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Audio` (then restart the
   Windows Audio service). The registration script prints these exact,
   reversible commands with `-AllowTestSigning` and **does not silently change
   system policy**.

| Item | Status |
| --- | --- |
| APO C++ source (`apo_dsp.h`, `bt_apo.cpp`) | ✅ written |
| Registration/unregistration script | ✅ written |
| DLL compiled on Windows | ❌ not done (no Windows/MSVC here) |
| APO loaded & audible on a device | ❌ not done |
| Code signing | ❌ external — requires a signing certificate (EV recommended) |

## 5. Configuration & data locations

| What | Where |
| --- | --- |
| App config, profiles, personalization | `%APPDATA%\BT AI Equalizer\config\` |
| API keys | OS credential store (`safeStorage`) or AES-256-GCM encrypted file (labeled in Settings) |
| APO runtime config (if used) | `%ProgramData%\BT-AI-Equalizer\apo-config.bin` |
| Logs | none written by default (privacy-first) |

## 6. Uninstall

- App: standard “Apps & features” uninstall (NSIS).
- APO (if registered): elevated `.\register-apo.ps1 -Unregister`, then reboot
  or restart the Windows Audio service.
- Personal data: delete `%APPDATA%\BT AI Equalizer\`.
