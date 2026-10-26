/**
 * BT AI Equalizer APO — user-mode Windows Audio Processing Object.
 *
 * Loaded into audiodg.exe by the Windows audio engine on the output endpoint
 * (the same mechanism Equalizer APO uses). Processes the final playback mix
 * system-wide: every application's audio passes through this APO.
 *
 * Implements:
 *   IAudioProcessingObject
 *   IAudioProcessingObjectRT   (real-time Process — must not allocate/lock/IO)
 *   IAudioProcessingObjectControls
 *   IAudioSystemEffects        (property store for settings)
 *
 * Settings are read from a shared memory-mapped config file written by the BT
 * AI Equalizer app (%ProgramData%\BT-AI-Equalizer\apo-config.bin), polled
 * cheaply by version counter — no IPC in the RT path.
 *
 * Build: cl /LD /std:c++17 /EHsc bt_apo.cpp /link /DLL /OUT:bt-ai-eq-apo.dll
 *        ole32.lib uuid.lib
 * Registration: see register-apo.ps1 (requires admin) and README.md.
 */
#include <windows.h>
#include <mmreg.h>
#include <audiopocli.h>  // APO interfaces
#include <mmdeviceapi.h>
#include <propkey.h>
#include <propvarutil.h>

#include <atomic>
#include <cstring>

#include "apo_dsp.h"

// {7D4A2C4E-9C3B-4F2A-9E1D-8B5F3A6C1B22}
static const CLSID CLSID_BtAiEqApo = {
  0x7d4a2c4e, 0x9c3b, 0x4f2a, {0x9e, 0x1d, 0x8b, 0x5f, 0x3a, 0x6c, 0x1b, 0x22}};

static const WCHAR* kConfigPath = L"\\??\\C:\\ProgramData\\BT-AI-Equalizer\\apo-config.bin";

// Minimal APO registration structures (documented APO_REG_PROPERTIES pattern).
static const APO_REG_PROPERTIES kRegProps = {
  CLSID_BtAiEqApo,
  APO_FLAG_SAMPLESPERFRAME_MUST_MATCH | APO_FLAG_FRAMESPERSECOND_MUST_MATCH |
      APO_FLAG_BITSPERSAMPLE_MUST_MATCH | APO_FLAG_INPLACE,
  {1, 1},   // minInput/maxInput connections
  {1, 1},
  {1, 1},
  L"BT AI Equalizer APO",
  L"Real-time DSP enhancement (BT Audio)"
};

class BtAiEqApo final : public IAudioProcessingObject,
                        public IAudioProcessingObjectRT,
                        public IAudioProcessingObjectControls {
 public:
  // ----- IUnknown -----
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IAudioProcessingObject)) {
      *ppv = static_cast<IAudioProcessingObject*>(this);
    } else if (riid == __uuidof(IAudioProcessingObjectRT)) {
      *ppv = static_cast<IAudioProcessingObjectRT*>(this);
    } else if (riid == __uuidof(IAudioProcessingObjectControls)) {
      *ppv = static_cast<IAudioProcessingObjectControls*>(this);
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
  STDMETHODIMP GetLatency(HNS* pTime) override {
    if (!pTime) return E_POINTER;
    *pTime = 0;  // in-place APO adds no algorithmic delay beyond the block
    return S_OK;
  }

  STDMETHODIMP GetRegistrationProperties(APO_REG_PROPERTIES** pRegProps) override {
    if (!pRegProps) return E_POINTER;
    *pRegProps = static_cast<APO_REG_PROPERTIES*>(
        CoTaskMemAlloc(sizeof(APO_REG_PROPERTIES)));
    if (!*pRegProps) return E_OUTOFMEMORY;
    std::memcpy(*pRegProps, &kRegProps, sizeof(APO_REG_PROPERTIES));
    return S_OK;
  }

  STDMETHODIMP Initialize(UINT32 cbDataSize, const BYTE* pbyData) override {
    // optional init blob from registration — accept empty
    (void)cbDataSize;
    (void)pbyData;
    return S_OK;
  }

  STDMETHODIMP IsInputFormatSupported(const APOConnectionProperty* pOutputFormat,
                                     const APOConnectionProperty* pRequestedInputFormat,
                                     APOConnectionProperty** ppSupportedInputFormat) override {
    return IsFormatSupported(pRequestedInputFormat, ppSupportedInputFormat);
  }

  STDMETHODIMP IsOutputFormatSupported(const APOConnectionProperty* pInputFormat,
                                      const APOConnectionProperty* pRequestedOutputFormat,
                                      APOConnectionProperty** ppSupportedOutputFormat) override {
    return IsFormatSupported(pRequestedOutputFormat, ppSupportedOutputFormat);
  }

  STDMETHODIMP GetInputConnectionProperties(const APOConnectionProperty* pOutputFormat,
                                           APOConnectionProperty** ppInputFormat) override {
    return CopyFormat(pOutputFormat, ppInputFormat);
  }

  STDMETHODIMP GetOutputConnectionProperties(const APOConnectionProperty* pInputFormat,
                                            APOConnectionProperty** ppOutputFormat) override {
    return CopyFormat(pInputFormat, ppOutputFormat);
  }

  STDMETHODIMP Reset() override {
    dsp_ = bt_apo::ApoDsp();
    configured_ = false;
    return S_OK;
  }

  // ----- IAudioProcessingObjectRT (real-time thread — no alloc/lock/IO) -----
  STDMETHODIMP_(void) APOProcess(UINT32 u32NumInputConnections,
                                 APOConnectionProperty** ppInputConnections,
                                 UINT32 u32NumOutputConnections,
                                 APOConnectionProperty** ppOutputConnections) override {
    if (u32NumInputConnections < 1 || u32NumOutputConnections < 1) return;
    auto* in = ppInputConnections[0];
    auto* out = ppOutputConnections[0];
    if (!in || !out || !in->pBuffer || !out->pBuffer) return;

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

    const UINT32 frames = in->u32ValidFrameCount;
    out->u32ValidFrameCount = frames;
    out->u32BufferFlags = in->u32BufferFlags;

    if (configured_) {
      dsp_.process(static_cast<float*>(out->pBuffer), (int)frames);
    } else if (out->pBuffer != in->pBuffer) {
      std::memcpy(out->pBuffer, in->pBuffer,
                  frames * channels_ * sizeof(float));
    }
  }

  // ----- IAudioProcessingObjectControls -----
  STDMETHODIMP LockForProcess() override { locked_ = true; return S_OK; }
  STDMETHODIMP UnlockForProcess() override { locked_ = false; return S_OK; }

  // called by the audio engine before processing begins
  void SetFormat(int frameRate, int channels) {
    frameRate_ = frameRate;
    channels_ = channels > 2 ? 2 : channels;
  }

 private:
  virtual ~BtAiEqApo() = default;

  static HRESULT CopyFormat(const APOConnectionProperty* src,
                            APOConnectionProperty** dst) {
    if (!src || !dst) return E_POINTER;
    *dst = static_cast<APOConnectionProperty*>(
        CoTaskMemAlloc(sizeof(APOConnectionProperty)));
    if (!*dst) return E_OUTOFMEMORY;
    std::memcpy(*dst, src, sizeof(APOConnectionProperty));
    return S_OK;
  }

  static HRESULT IsFormatSupported(const APOConnectionProperty* requested,
                                   APOConnectionProperty** supported) {
    return CopyFormat(requested, supported);
  }

  bool TryLoadConfig(bt_apo::ApoParams* out, uint32_t* size) {
    // file mapping opened once (outside RT); reads are plain memcpy
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
    // layout: [magic u32][version u32][size u32][payload…]
    if (hdr[0] != 0x42544150) return false;  // "BTAP"
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
  bool locked_ = false;
  int frameRate_ = 48000;
  int channels_ = 2;
};

// ---------------------------------------------------------------------------
// COM factory + registration (self-registering DLL)
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
