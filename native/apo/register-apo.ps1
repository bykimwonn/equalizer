# register-apo.ps1 — register/unregister the BT AI Equalizer APO (ADMIN REQUIRED)
#
# This script performs EXACTLY the documented APO registration steps used by
# Equalizer APO-style system-wide enhancers:
#   1. Copy the DLL to %ProgramFiles%\BT-AI-Equalizer\
#   2. Register the COM CLSID (inproc server)
#   3. Add the APO to the endpoint FxProperties chain (SFX/MFX/EFX)
#
# IMPORTANT — read before running:
#   * Windows only loads APOs into audiodg.exe if they are signed, OR the
#     machine is test-signed, OR the DisableProtectedAudioDG override is set
#     (documented Microsoft restriction — "Protected Audio DG"). This script
#     will NOT silently flip security policy. Pass -AllowTestSigning to see
#     the exact (reversible) instructions instead of doing it for you.
#   * Modifying the endpoint FX chain affects the DEFAULT render endpoint only
#     when you pass -ApplyToDefaultEndpoint. Nothing is changed without consent.
#   * This script has NOT been run on the build machine. Verify on a Windows
#     test box before distributing. See docs/INSTALL-WINDOWS.md.
#
# Usage (from an elevated PowerShell):
#   .\register-apo.ps1 -DllPath .\bin\bt-ai-eq-apo.dll -ApplyToDefaultEndpoint
#   .\register-apo.ps1 -Unregister

param(
    [string]$DllPath = ".\bin\bt-ai-eq-apo.dll",
    [switch]$ApplyToDefaultEndpoint,
    [switch]$AllowTestSigning,
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$clsid = "{7D4A2C4E-9C3B-4F2A-9E1D-8B5F3A6C1B22}"
$installDir = Join-Path $env:ProgramFiles "BT-AI-Equalizer"
$clsidKey = "HKLM:\SOFTWARE\Classes\CLSID\$clsid"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Error "This script must run from an elevated (Administrator) PowerShell."
    exit 1
}

if ($Unregister) {
    Write-Host "Unregistering BT AI Equalizer APO..."
    Remove-Item -Path $clsidKey -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $installDir) { Remove-Item -Path $installDir -Recurse -Force }
    Write-Host "Done. Reboot or restart the Windows Audio service to unload the APO."
    exit 0
}

if (-not (Test-Path $DllPath)) { Write-Error "DLL not found: $DllPath"; exit 1 }

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item $DllPath (Join-Path $installDir "bt-ai-eq-apo.dll") -Force
$dllFull = Join-Path $installDir "bt-ai-eq-apo.dll"

# Config folder the app writes (APO polls apo-config.bin there). Created with a
# Users-modify ACL so the non-elevated app can update it. Uses the well-known
# SID S-1-5-32-545 (BUILTIN\Users) to avoid localized group names.
Write-Host "Creating APO config folder with user-write access..."
$cfgDir = Join-Path $env:ProgramData "BT-AI-Equalizer"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
icacls $cfgDir /grant "*S-1-5-32-545:(OI)(CI)M" | Out-Null

Write-Host "Registering COM server..."
New-Item -Path $clsidKey -Force | Out-Null
New-Item -Path "$clsidKey\InprocServer32" -Force | Out-Null
Set-ItemProperty -Path "$clsidKey\InprocServer32" -Name "(default)" -Value $dllFull
Set-ItemProperty -Path "$clsidKey\InprocServer32" -Name "ThreadingModel" -Value "Both"

if ($ApplyToDefaultEndpoint) {
    Write-Host "Adding APO to the default render endpoint FX chain (SFX)..."
    # Locate the default render endpoint id via the MMDevices registry view.
    $renderRoot = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
    $defaultId = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render" -ErrorAction SilentlyContinue).Default
    if (-not $defaultId) {
        Write-Warning "Could not resolve the default endpoint id automatically."
        Write-Warning "Open regedit and add the APO CLSID to the FxProperties of the desired endpoint under $renderRoot\{endpoint}\FxProperties (value '1' = SFX, chain as multistring)."
    } else {
        $fxKey = "$renderRoot\$defaultId\FxProperties"
        New-Item -Path $fxKey -Force | Out-Null
        # {1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5 = SFX APO CLSID list (documented endpoint FX property)
        Set-ItemProperty -Path $fxKey -Name "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5" -Value $clsid -Type String
        Write-Host "SFX chain updated for endpoint $defaultId"
    }
} else {
    Write-Host "Skipped endpoint FX registration (no -ApplyToDefaultEndpoint)."
}

if ($AllowTestSigning) {
    Write-Host ""
    Write-Host "=== Unsigned APO loading — EXACT steps (reversible) ===" -ForegroundColor Yellow
    Write-Host "Windows blocks unsigned APOs in audiodg.exe unless one of:"
    Write-Host "  a) the DLL is signed with a trusted certificate (recommended for release)"
    Write-Host "  b) test signing is enabled:  bcdedit /set testsigning on   (reboot)"
    Write-Host "  c) the documented DisableProtectedAudioDG registry override:"
    Write-Host "     HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Audio"
    Write-Host "     DisableProtectedAudioDG = 1 (DWORD)  →  restart Windows Audio service"
    Write-Host "This script does NOT change system policy for you."
} else {
    Write-Host "Note: a production APO must be code-signed. See docs/INSTALL-WINDOWS.md."
}

Write-Host "Done. Restart the Windows Audio service (net stop Audiosrv / net start Audiosrv) or reboot."
