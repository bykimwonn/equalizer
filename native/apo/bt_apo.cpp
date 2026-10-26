/**
 * BT AI Equalizer APO — user-mode Windows Audio Processing Object.
 *
 * Loaded into audiodg.exe by the Windows audio engine on the output endpoint
 * (the same mechanism Equalizer APO uses). Processes the final playback mix
 * system-wide: every application's audio passes through this APO.
 *
 * Interfaces (exact SDK signatures from audioenginebaseapo.h / mmreg.h):
 *   IAudioProcessingObject            — Reset, GetLatency, GetRegistrationProperties,
 *                                       Initialize, IsInput/OutputFormatSupported (IAudioMediaType),
 *                                       GetInputChannelCount
 *   IAudioProcessingObjectRT          — APOProcess, CalcInputFrames, CalcOutputFrames
 *   IAudioProcessingObjectConfiguration — LockForProcess, UnlockForProcess
 *
 * Real-time safety: APOProcess performs no allocation, locking, or I/O.
 * Settings come from a memory-mapped config file written by the BT app
 * (%ProgramData%\BT-AI-Equalizer\apo-config.bin), polled by atomic version.
 *
 * Build: cl /LD /std:c++17 /EHsc bt_apo.cpp apo_dsp.h /link /DLL
 *        /OUT:bin\bt-ai-eq-apo.dll ole32.lib uuid.lib
 * Registration: register-apo.ps1 (admin) — see README.md for signing rules.
 */
#include <windows.h>
#include <objbase.h>
#include <mmreg.h>             // APO_CONNECTION_PROPERTY, WAVEFORMATEX
#include <audiomediatype.h>    // IAudioMediaType
#include <audioenginebaseapo.h>// APO interfaces, APO_REG_PROPERTIES, APO_CONNECTION_DESCRIPTOR

#include <atomic>
#include <cstring>

#include "apo_dsp.h"

// {7D4A2C4E-9C3B-4F2A-9E1D-8B5F3A6C1B22}
static const CLSID CLSID_BtAiEqApo = {
  0x7d4a2c4e, 0x9c3b, 0x4f2a, {0x9e, 0x1d, 0x8b, 0x5f, 0x3a, 0x6c, 0x1b, 0x22}};

static const APO_REG_PROPERTIES kRegProps = {
  CLSID_BtAiEqApo,
  static_cast<APO_FLAG>(APO_FLAG_DEFAULT | APO_FLAG_INPLACE),
  L"BT AI Equalizer APO",              // szFriendlyName[256]
  L"Copyright (c) 2026 BT Audio",      // szCopyrightInfo[256]
  1, 0,                                // u32MajorVersion, u32MinorVersion
  1, 1,                                // min/max input connections
  1, 1,                                // min/max output connections
  1,                                   // u32MaxInstances
  1,                                   // u32NumAPOInterfaces
  { IID_IAudioProcessingObject }       // iidAPOInterfaceList[1]
};

class BtAiEqApo final : public IAudioProcessingObject,
                        public IAudioProcessingObjectRT,
                        public IAudioProcessingObjectConfiguration {
 public:
  // ----- IUnknown -----
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IAudioProcessingObject)) {
      *ppv = static_cast<IAudioProcessingObject*>(this);
    } else if (riid == __uuidof(IAudioProcessingObjectRT)) {
      *ppv = static_cast<IAudioProcessingObjectRT*>(this);
    } else if (riid == __uuidof(IAudioProcessingObjectConfiguration)) {
      *ppv = static_cast<IAudioProcessingObjectConfiguration*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override { return ++refCount_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = --refCount_;
    if (r == 0) delete this;
    return r;
  }

  // ----- IAudioProcessingObject -----
  STDMETHODIMP Reset() override {
    dsp_ = bt_apo::ApoDsp();
    configured_ = false;
    return S_OK;
  }

  STDMETHODIMP GetLatency(HNSTIME* pTime) override {
    if (!pTime) return E_POINTER;
    *pTime = 0;  // in-place APO adds no algorithmic delay beyond the block
    return S_OK;
  }

  STDMETHODIMP GetRegistrationProperties(APO_REG_PROPERTIES** ppRegProps) override {
    if (!ppRegProps) return E_POINTER;
    *ppRegProps = static_cast<APO_REG_PROPERTIES*>(
        CoTaskMemAlloc(sizeof(APO_REG_PROPERTIES)));
    if (!*ppRegProps) return E_OUTOFMEMORY;
    std::memcpy(*ppRegProps, &kRegProps, sizeof(APO_REG_PROPERTIES));
    return S_OK;
  }

  STDMETHODIMP Initialize(UINT32 cbDataSize, BYTE* pbyData) override {
    (void)cbDataSize;
    (void)pbyData;
    if (initialized_) return APOERR_ALREADY_INITIALIZED;
    initialized_ = true;
    return S_OK;
  }

  // We accept the mix format the engine offers (float32 PCM) unchanged.
  STDMETHODIMP IsInputFormatSupported(IAudioMediaType* /*pOppositeFormat*/,
                                     IAudioMediaType* pRequestedInputFormat,
                                     IAudioMediaType** ppSupportedInputFormat) override {
    return AcceptFormat(pRequestedInputFormat, ppSupportedInputFormat);
  }

  STDMETHODIMP IsOutputFormatSupported(IAudioMediaType* /*pOppositeFormat*/,
                                      IAudioMediaType* pRequestedOutputFormat,
                                      IAudioMediaType** ppSupportedOutputFormat) override {
    return AcceptFormat(pRequestedOutputFormat, ppSupportedOutputFormat);
  }

  STDMETHODIMP GetInputChannelCount(UINT32* pu32ChannelCount) override {
    if (!pu32ChannelCount) return E_POINTER;
    *pu32ChannelCount = channels_;
    return S_OK;
  }

  // ----- IAudioProcessingObjectConfiguration -----
  STDMETHODIMP LockForProcess(UINT32 u32NumInputConnections,
                              APO_CONNECTION_DESCRIPTOR** ppInputConnections,
                              UINT32 u32NumOutputConnections,
                              APO_CONNECTION_DESCRIPTOR** ppOutputConnections) override {
    if (u32NumInputConnections < 1 || u32NumOutputConnections < 1) {
      return APOERR_NUM_CONNECTIONS_INVALID;
    }
    if (!ppInputConnections || !ppOutputConnections) return E_POINTER;

    // learn channels / sample rate from the negotiated input format
    if (ppInputConnections[0] && ppInputConnections[0]->pFormat) {
      const WAVEFORMATEX* fmt = ppInputConnections[0]->pFormat->GetAudioFormat();
      if (fmt) {
        channels_ = fmt->nChannels > 2 ? 2 : (int)fmt->nChannels;
        frameRate_ = (int)fmt->nSamplesPerSec;
      }
    }
    locked_ = true;
    return S_OK;
  }

  STDMETHODIMP UnlockForProcess() override {
    if (!locked_) return APOERR_ALREADY_UNLOCKED;
    locked_ = false;
    return S_OK;
  }

  // ----- IAudioProcessingObjectRT (real-time thread: no alloc/lock/IO) -----
  STDMETHODIMP_(void) APOProcess(UINT32 u32NumInputConnections,
                                 APO_CONNECTION_PROPERTY** ppInputConnections,
                                 UINT32 u32NumOutputConnections,
                                 APO_CONNECTION_PROPERTY** ppOutputConnections) override {
    if (u32NumInputConnections < 1 || u32NumOutputConnections < 1) return;
    if (!ppInputConnections || !ppOutputConnections) return;
    APO_CONNECTION_PROPERTY* in = ppInputConnections[0];
    APO_CONNECTION_PROPERTY* out = ppOutputConnections[0];
    if (!in || !out) return;

    const UINT32 frames = in->u32ValidFrameCount;
    out->u32ValidFrameCount = frames;
    out->u32BufferFlags = in->u32BufferFlags;

    // cheap config poll (atomic load; memcpy only when version changed)
    const uint32_t v = configVersion_.load(std::memory_order_acquire);
    if (v != appliedVersion_) {
      bt_apo::ApoParams p;
      uint32_t sz = 0;
      if (TryLoadConfig(&p, &sz)) {
        dsp_.configure(p, (float)frameRate_, channels_);
        appliedVersion_ = v;
        configured_ = true;
      }
    }

    float* dst = reinterpret_cast<float*>(out->pBuffer);
    const float* src = reinterpret_cast<const float*>(in->pBuffer);
    if (!dst || !src) return;

    if (dst != src) {
      std::memcpy(dst, src, (size_t)frames * channels_ * sizeof(float));
    }
    if (configured_) {
      dsp_.process(dst, (int)frames);
    }
  }

  STDMETHODIMP_(UINT32) CalcInputFrames(UINT32 u32OutputFrameCount) override {
    return u32OutputFrameCount;  // 1:1 processing
  }

  STDMETHODIMP_(UINT32) CalcOutputFrames(UINT32 u32InputFrameCount) override {
    return u32InputFrameCount;
  }

 private:
  virtual ~BtAiEqApo() = default;

  static HRESULT AcceptFormat(IAudioMediaType* requested, IAudioMediaType** supported) {
    if (!supported) return E_POINTER;
    if (!requested) return E_POINTER;
    requested->AddRef();
    *supported = requested;  // accept the engine's float32 mix format as-is
    return S_OK;
  }

  bool TryLoadConfig(bt_apo::ApoParams* out, uint32_t* size) {
    // file mapping opened once (outside RT); RT reads are plain memcpy
    if (!mapped_) {
      HANDLE h = CreateFileW(L"C:\\ProgramData\\BT-AI-Equalizer\\apo-config.bin",
                             GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (h == INVALID_HANDLE_VALUE) return false;
      HANDLE map = CreateFileMappingW(h, nullptr, PAGE_READONLY, 0, 0, nullptr);
      CloseHandle(h);
      if (!map) return false;
      mapped_ = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
      CloseHandle(map);
      if (!mapped_) return false;
    }
    const auto* hdr = static_cast<const uint32_t*>(mapped_);
    // layout: [magic u32 = 'BTAP'][version u32][size u32][payload…]
    if (hdr[0] != 0x42544150) return false;
    *size = hdr[2];
    std::memcpy(out, static_cast<const uint8_t*>(mapped_) + 12,
                sizeof(bt_apo::ApoParams) < *size ? sizeof(bt_apo::ApoParams) : *size);
    return true;
  }

  std::atomic<ULONG> refCount_{1};
  std::atomic<uint32_t> configVersion_{0};
  uint32_t appliedVersion_ = 0;
  void* mapped_ = nullptr;
  bt_apo::ApoDsp dsp_;
  bool configured_ = false;
  bool initialized_ = false;
  bool locked_ = false;
  int frameRate_ = 48000;
  int channels_ = 2;
};

// ---------------------------------------------------------------------------
// COM factory + self-registration
// ---------------------------------------------------------------------------

class BtApoFactory : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IClassFactory)) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 1; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    auto* apo = new BtAiEqApo();
    HRESULT hr = apo->QueryInterface(riid, ppv);
    apo->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL) override { return S_OK; }
};

extern "C" __declspec(dllexport) HRESULT __stdcall DllGetClassObject(REFCLSID rclsid,
                                                                     REFIID riid,
                                                                     void** ppv) {
  if (rclsid != CLSID_BtAiEqApo) return CLASS_E_CLASSNOTAVAILABLE;
  static BtApoFactory factory;
  return factory.QueryInterface(riid, ppv);
}

extern "C" __declspec(dllexport) HRESULT __stdcall DllCanUnloadNow() {
  return S_FALSE;  // keep loaded for the audio engine session
}

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) {
  return TRUE;
}
