/**
 * bt_wasapi — WASAPI capture/render engine (Windows only).
 *
 * Capture modes:
 *  - "process-loopback" (default): uses the documented
 *    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK with
 *    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE targeting the BT
 *    process tree. Captures the system audio mix EXCEPT our own render
 *    stream, so processing and rendering to the same device creates no
 *    feedback loop. Available on Windows 10 2004+ (build 19041).
 *  - "loopback": classic endpoint loopback (AUDCLNT_STREAMFLAGS_LOOPBACK)
 *    of the selected/default render endpoint. Use with a virtual cable
 *    render target to avoid feedback.
 *
 * Render: shared-mode WASAPI float32, event-driven, same mix format as the
 * endpoint (we convert to/from stereo float32 deinterleaved for the DSP).
 *
 * Real-time safety: the audio thread captures one period, hands it to the JS
 * process callback synchronously (blocking ThreadSafeFunction), then renders
 * the processed buffer. No locks beyond a small state mutex around start/stop.
 */
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <objbase.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "wasapi_engine.h"

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "avrt.lib")

namespace bt {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static std::wstring Widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
  return w;
}

static std::string Narrow(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static bool GuidFromString(const std::string& s, GUID* out) {
  std::wstring w = Widen(s);
  return SUCCEEDED(CLSIDFromString(w.c_str(), out));
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

std::vector<DeviceInfo> EnumerateDevices() {
  std::vector<DeviceInfo> out;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              (void**)enumerator.put()))) {
    return out;
  }

  for (int flow = 0; flow < 2; ++flow) {
    EDataFlow dataFlow = flow == 0 ? eRender : eCapture;
    ComPtr<IMMDeviceCollection> coll;
    if (FAILED(enumerator->EnumAudioEndpoints(dataFlow, DEVICE_STATE_ACTIVE, coll.put()))) continue;

    UINT count = 0;
    coll->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> dev;
      if (FAILED(coll->Item(i, dev.put()))) continue;

      LPWSTR id = nullptr;
      dev->GetId(&id);
      DeviceInfo info;
      info.id = id ? Narrow(id) : "";
      if (id) CoTaskMemFree(id);

      ComPtr<IPropertyStore> props;
      if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, props.put()))) {
        PROPVARIANT var;
        PropVariantInit(&var);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var)) && var.pwszVal) {
          info.name = Narrow(var.pwszVal);
        }
        PropVariantClear(&var);
      }

      info.isRender = (dataFlow == eRender);
      info.isCapture = (dataFlow == eCapture);
      info.loopbackSupported = info.isRender; // render endpoints can be loopback-captured

      // default device?
      ComPtr<IMMDevice> def;
      if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(dataFlow, eConsole, def.put()))) {
        LPWSTR defId = nullptr;
        def->GetId(&defId);
        if (defId) {
          info.isDefault = (info.id == Narrow(defId));
          CoTaskMemFree(defId);
        }
      }

      // basic capabilities from the shared mix format
      ComPtr<IAudioClient> client;
      if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  (void**)client.put()))) {
        WAVEFORMATEX* fmt = nullptr;
        if (SUCCEEDED(client->GetMixFormat(&fmt)) && fmt) {
          info.sampleRates = { (int)fmt->nSamplesPerSec };
          info.channels = fmt->nChannels;
          CoTaskMemFree(fmt);
        }
      }

      out.push_back(info);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WasapiEngine
// ---------------------------------------------------------------------------

WasapiEngine::WasapiEngine() = default;
WasapiEngine::~WasapiEngine() { Stop(); }

void WasapiEngine::SetProcessCallback(ProcessCallback cb) {
  std::lock_guard<std::mutex> lock(mutex_);
  processCb_ = std::move(cb);
}

bool WasapiEngine::Start(const StreamConfig& cfg, std::string* error) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (running_) {
    if (error) *error = "stream already running";
    return false;
  }
  cfg_ = cfg;
  stop_ = false;

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool coInitHere = SUCCEEDED(hr);
  (void)coInitHere;

  if (!OpenCapture(error) || !OpenRender(error)) {
    Cleanup();
    return false;
  }

  running_ = true;
  audioThread_ = std::thread([this] { AudioLoop(); });
  return true;
}

void WasapiEngine::Stop() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stop_ = true;
  }
  if (captureClient_) captureClient_->Stop();
  if (renderClient_) renderClient_->Stop();
  if (audioThread_.joinable()) audioThread_.join();
  std::lock_guard<std::mutex> lock(mutex_);
  running_ = false;
  Cleanup();
}

void WasapiEngine::Cleanup() {
  captureClient_.reset();
  captureAudioClient_.reset();
  renderClient_.reset();
  renderAudioClient_.reset();
  captureEvent_ = nullptr;
  renderEvent_ = nullptr;
}

bool WasapiEngine::OpenCapture(std::string* error) {
  HRESULT hr;

  if (cfg_.captureMode == "process-loopback") {
    // Windows 10 2004+: per-process loopback via activation interface.
    // EXCLUDE_TARGET_PROCESS_TREE with the BT PID captures everything except
    // our own render stream — no feedback when rendering to the same device.
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    params.ProcessLoopbackParams.TargetProcessId = cfg_.excludePid
        ? cfg_.excludePid
        : GetCurrentProcessId();

    AUDIOCLIENT_ACTIVATION_TYPE activationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    PROPVARIANT var;
    PropVariantInit(&var);
    var.vt = VT_BLOB;
    var.blob.cbSize = sizeof(params);
    var.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    IAudioClient* raw = nullptr;
    hr = ActivateAudioInterfaceAsync(
        cfg_.captureDeviceId.empty() || cfg_.captureDeviceId == "default"
            ? VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
            : Widen(cfg_.captureDeviceId).c_str(),
        __uuidof(IAudioClient), &var, &activationAsync_.put());
    PropVariantClear(&var);

    if (SUCCEEDED(hr)) {
      // wait (bounded) for activation completion
      DWORD waited = 0;
      while (!activationAsync_->IsComplete() && waited < 3000) {
        Sleep(5);
        waited += 5;
      }
      hr = activationAsync_->GetActivateResult(&activationType, (IUnknown**)&raw);
    }
    if (FAILED(hr) || !raw) {
      // fall back to classic loopback so the app still captures audio
      if (error) *error = "process-loopback activation failed (requires Windows 10 2004+); falling back to classic loopback";
      return OpenCaptureClassic(error);
    }
    captureAudioClient_.attach(raw);
  } else {
    if (!OpenCaptureClassic(error)) return false;
  }

  WAVEFORMATEX* fmt = nullptr;
  if (FAILED(captureAudioClient_->GetMixFormat(&fmt)) || !fmt) {
    if (error) *error = "GetMixFormat(capture) failed";
    return false;
  }
  captureRate_ = fmt->nSamplesPerSec;
  captureChannels_ = fmt->nChannels;
  CoTaskMemFree(fmt);

  REFERENCE_TIME buffer = 20000 * 1000; // 20 ms default engine period request
  hr = captureAudioClient_->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      buffer, 0, nullptr, nullptr);
  if (FAILED(hr)) {
    if (error) *error = "IAudioClient::Initialize(capture) failed: " + std::to_string(hr);
    return false;
  }
  if (FAILED(captureAudioClient_->GetService(__uuidof(IAudioCaptureClient),
                                             (void**)captureClient_.put()))) {
    if (error) *error = "GetService(IAudioCaptureClient) failed";
    return false;
  }
  return true;
}

bool WasapiEngine::OpenCaptureClassic(std::string* error) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void**)enumerator.put()))) {
    if (error) *error = "MMDeviceEnumerator creation failed";
    return false;
  }

  ComPtr<IMMDevice> dev;
  HRESULT hr;
  if (cfg_.captureDeviceId.empty() || cfg_.captureDeviceId == "default") {
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, dev.put());
  } else {
    hr = enumerator->GetDevice(Widen(cfg_.captureDeviceId).c_str(), dev.put());
  }
  if (FAILED(hr)) {
    if (error) *error = "capture device not found";
    return false;
  }

  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                     (void**)captureAudioClient_.put());
  if (FAILED(hr)) {
    if (error) *error = "capture device Activate failed";
    return false;
  }

  // mix format must be known before Initialize for loopback
  WAVEFORMATEX* fmt = nullptr;
  if (SUCCEEDED(captureAudioClient_->GetMixFormat(&fmt)) && fmt) {
    captureRate_ = fmt->nSamplesPerSec;
    captureChannels_ = fmt->nChannels;
    CoTaskMemFree(fmt);
  }

  REFERENCE_TIME buffer = 20000 * 1000;
  hr = captureAudioClient_->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
      buffer, 0, nullptr, nullptr);
  if (FAILED(hr)) {
    if (error) *error = "IAudioClient::Initialize(loopback) failed: " + std::to_string(hr);
    return false;
  }
  if (FAILED(captureAudioClient_->GetService(__uuidof(IAudioCaptureClient),
                                             (void**)captureClient_.put()))) {
    if (error) *error = "GetService(IAudioCaptureClient) failed";
    return false;
  }
  return true;
}

bool WasapiEngine::OpenRender(std::string* error) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void**)enumerator.put()))) {
    if (error) *error = "MMDeviceEnumerator creation failed (render)";
    return false;
  }

  ComPtr<IMMDevice> dev;
  HRESULT hr;
  if (cfg_.renderDeviceId.empty() || cfg_.renderDeviceId == "default") {
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, dev.put());
  } else {
    hr = enumerator->GetDevice(Widen(cfg_.renderDeviceId).c_str(), dev.put());
  }
  if (FAILED(hr)) {
    if (error) *error = "render device not found";
    return false;
  }

  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                     (void**)renderAudioClient_.put());
  if (FAILED(hr)) {
    if (error) *error = "render device Activate failed";
    return false;
  }

  WAVEFORMATEX* fmt = nullptr;
  if (FAILED(renderAudioClient_->GetMixFormat(&fmt)) || !fmt) {
    if (error) *error = "GetMixFormat(render) failed";
    return false;
  }
  renderRate_ = fmt->nSamplesPerSec;
  renderChannels_ = fmt->nChannels;
  renderBits_ = fmt->wBitsPerSample;
  isFloat_ = (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ||
             (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
              reinterpret_cast<WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat ==
                  KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
  CoTaskMemFree(fmt);

  REFERENCE_TIME buffer = 20000 * 1000;
  hr = renderAudioClient_->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, buffer, 0, nullptr, nullptr);
  if (FAILED(hr)) {
    if (error) *error = "IAudioClient::Initialize(render) failed: " + std::to_string(hr);
    return false;
  }
  if (FAILED(renderAudioClient_->GetService(__uuidof(IAudioRenderClient),
                                            (void**)renderClient_.put()))) {
    if (error) *error = "GetService(IAudioRenderClient) failed";
    return false;
  }
  return true;
}

void WasapiEngine::AudioLoop() {
  // MMCSS registration for glitch resistance
  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  captureClient_->Start();
  renderClient_->Start();

  std::vector<float> inL, inR, outL, outR;

  while (!stop_) {
    // ---- capture one period ----
    UINT32 packet = 0;
    if (FAILED(captureClient_->GetNextPacketSize(&packet))) break;

    UINT32 frames = 0;
    BYTE* data = nullptr;
    DWORD flags = 0;
    HRESULT hr = captureClient_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) {
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
        // device changed — recoverable; outer watchdog restarts us
        break;
      }
      Sleep(2);
      continue;
    }

    if (frames > 0) {
      inL.resize(frames);
      inR.resize(frames);
      Deinterleave(data, frames, captureChannels_, isFloat_, inL.data(), inR.data());
    }
    captureClient_->ReleaseBuffer(frames);
    if (frames == 0) {
      Sleep(1);
      continue;
    }

    // ---- DSP callback (synchronous; JS runs engine.process) ----
    outL = inL;
    outR = inR;
    if (processCb_) {
      processCb_(outL, outR);
    }

    // ---- render the processed block ----
    UINT32 padding = 0;
    renderAudioClient_->GetCurrentPadding(&padding);
    UINT32 renderFrames = 0;
    if (SUCCEEDED(renderAudioClient_->GetBufferSize(&renderFrames))) {
      UINT32 want = renderFrames - padding;
      if (want > 0) {
        BYTE* out = nullptr;
        UINT32 toWrite = want < (UINT32)outL.size() ? want : (UINT32)outL.size();
        if (SUCCEEDED(renderClient_->GetBuffer(toWrite, &out)) && out) {
          Interleave(out, toWrite, renderChannels_, isFloat_, outL.data(), outR.data());
          renderClient_->ReleaseBuffer(toWrite, 0);
        }
      }
    }
  }

  captureClient_->Stop();
  renderClient_->Stop();
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
}

void WasapiEngine::Deinterleave(const BYTE* data, UINT32 frames, UINT32 channels,
                                bool isFloat, float* L, float* R) {
  if (isFloat) {
    const float* src = reinterpret_cast<const float*>(data);
    for (UINT32 i = 0; i < frames; ++i) {
      L[i] = channels > 0 ? src[i * channels] : 0.f;
      R[i] = channels > 1 ? src[i * channels + 1] : L[i];
    }
  } else {
    const short* src = reinterpret_cast<const short*>(data);
    for (UINT32 i = 0; i < frames; ++i) {
      L[i] = channels > 0 ? src[i * channels] / 32768.f : 0.f;
      R[i] = channels > 1 ? src[i * channels + 1] / 32768.f : L[i];
    }
  }
}

void WasapiEngine::Interleave(BYTE* data, UINT32 frames, UINT32 channels,
                              bool isFloat, const float* L, const float* R) {
  if (isFloat) {
    float* dst = reinterpret_cast<float*>(data);
    for (UINT32 i = 0; i < frames; ++i) {
      if (channels > 0) dst[i * channels] = L[i];
      if (channels > 1) dst[i * channels + 1] = R[i];
    }
  } else {
    short* dst = reinterpret_cast<short*>(data);
    for (UINT32 i = 0; i < frames; ++i) {
      auto clamp16 = [](float v) {
        v = v > 1.f ? 1.f : (v < -1.f ? -1.f : v);
        return (short)(v * 32767.f);
      };
      if (channels > 0) dst[i * channels] = clamp16(L[i]);
      if (channels > 1) dst[i * channels + 1] = clamp16(R[i]);
    }
  }
}

}  // namespace bt
