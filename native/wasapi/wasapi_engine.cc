/**
 * bt_wasapi — WASAPI capture/render engine (Windows only).
 *
 * Capture modes:
 *  - "process-loopback" (default): documented
 *    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK via
 *    ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ...)
 *    with PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE targeting the BT
 *    process tree — captures the system audio mix EXCEPT our own render
 *    stream, so processing and rendering to the same device creates no
 *    feedback loop. Requires Windows 10 build 20348+ (audioclientactivationparams.h).
 *    Note: the activated client's GetMixFormat returns E_NOTIMPL by design
 *    (it is not tied to an endpoint); the stream format is chosen explicitly.
 *  - "loopback": classic endpoint loopback (AUDCLNT_STREAMFLAGS_LOOPBACK) of
 *    the selected/default render endpoint. Use with a virtual cable render
 *    target to avoid feedback.
 *
 * Both capture and render streams are opened in a fixed DSP format (float32
 * stereo at the configured sample rate) with AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
 * so the audio engine performs any needed rate/format conversion. Streams are
 * event-driven; the audio thread drains capture packets (one synchronous JS
 * process callback per block), stages the processed audio in a small FIFO, and
 * feeds the render stream from it (silence when empty).
 *
 * Real-time safety: the audio thread captures one period, hands it to the JS
 * process callback synchronously (blocking ThreadSafeFunction), then renders.
 * No locks beyond a small state mutex around start/stop.
 */
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <objbase.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <algorithm>
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

namespace {

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

// Completion handler for ActivateAudioInterfaceAsync. Windows delivers
// ActivateCompleted on an MTA worker thread, so — as in Microsoft's
// ApplicationLoopback sample — the handler is agile (RuntimeClass + FtmBase).
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() : event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (event_) CloseHandle(event_);
  }

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    resultHr_ = E_FAIL;
    if (operation) {
      HRESULT hrActivate = E_UNEXPECTED;
      ComPtr<IUnknown> punk;
      if (SUCCEEDED(operation->GetActivateResult(&hrActivate, &punk))) {
        resultHr_ = SUCCEEDED(hrActivate) ? punk.As(&client_) : hrActivate;
      }
    }
    if (event_) SetEvent(event_);
    return S_OK;
  }

  bool Wait(DWORD ms) {
    return event_ && WaitForSingleObject(event_, ms) == WAIT_OBJECT_0;
  }
  HRESULT result() const { return resultHr_; }
  ComPtr<IAudioClient>& client() { return client_; }

 private:
  HANDLE event_ = nullptr;
  HRESULT resultHr_ = E_UNEXPECTED;
  ComPtr<IAudioClient> client_;
};

}  // namespace

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

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

std::vector<DeviceInfo> EnumerateDevices() {
  std::vector<DeviceInfo> out;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerator)))) {
    return out;
  }

  for (int flow = 0; flow < 2; ++flow) {
    EDataFlow dataFlow = flow == 0 ? eRender : eCapture;
    ComPtr<IMMDeviceCollection> coll;
    if (FAILED(enumerator->EnumAudioEndpoints(dataFlow, DEVICE_STATE_ACTIVE, &coll))) continue;

    UINT count = 0;
    coll->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> dev;
      if (FAILED(coll->Item(i, &dev))) continue;

      LPWSTR id = nullptr;
      dev->GetId(&id);
      DeviceInfo info;
      info.id = id ? Narrow(id) : "";
      if (id) CoTaskMemFree(id);

      ComPtr<IPropertyStore> props;
      if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
        PROPVARIANT var;
        PropVariantInit(&var);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var)) && var.pwszVal) {
          info.name = Narrow(var.pwszVal);
        }
        PropVariantClear(&var);
      }

      info.isRender = (dataFlow == eRender);
      info.isCapture = (dataFlow == eCapture);
      info.loopbackSupported = info.isRender;  // render endpoints can be loopback-captured

      // default device?
      ComPtr<IMMDevice> def;
      if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(dataFlow, eConsole, &def))) {
        LPWSTR defId = nullptr;
        def->GetId(&defId);
        if (defId) {
          info.isDefault = (info.id == Narrow(defId));
          CoTaskMemFree(defId);
        }
      }

      // basic capabilities from the shared mix format (works on real endpoints —
      // only the process-loopback virtual device returns E_NOTIMPL here)
      ComPtr<IAudioClient> client;
      if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(client.GetAddressOf())))) {
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

  HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  (void)hrCo;  // RPC_E_CHANGED_MODE is fine — the thread is already initialized.

  int rate = cfg_.sampleRate;
  if (rate < 8000 || rate > 384000) rate = 48000;
  dspRate_ = rate;
  dspFormat_.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  dspFormat_.nChannels = 2;
  dspFormat_.nSamplesPerSec = (DWORD)rate;
  dspFormat_.wBitsPerSample = 32;
  dspFormat_.nBlockAlign = 8;
  dspFormat_.nAvgBytesPerSec = (DWORD)rate * 8;
  dspFormat_.cbSize = 0;

  captureEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  renderEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!captureEvent_ || !renderEvent_) {
    if (error) *error = "CreateEvent failed";
    Cleanup();
    return false;
  }

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
    // Wake the wait immediately so the audio thread can exit promptly.
    if (captureEvent_) SetEvent(captureEvent_);
    if (renderEvent_) SetEvent(renderEvent_);
  }
  if (audioThread_.joinable()) audioThread_.join();
  std::lock_guard<std::mutex> lock(mutex_);
  running_ = false;
  Cleanup();
}

void WasapiEngine::Cleanup() {
  captureClient_ = nullptr;
  captureAudioClient_ = nullptr;
  renderClient_ = nullptr;
  renderAudioClient_ = nullptr;
  if (captureEvent_) { CloseHandle(captureEvent_); captureEvent_ = nullptr; }
  if (renderEvent_) { CloseHandle(renderEvent_); renderEvent_ = nullptr; }
  renderBufFrames_ = 0;
  fifoL_.clear();
  fifoR_.clear();
  fifoHead_ = 0;
}

bool WasapiEngine::OpenCapture(std::string* error) {
  if (cfg_.captureMode == "process-loopback") {
    if (!ActivateProcessLoopback(error)) {
      // Honest fallback so the app still captures audio (classic loopback of
      // the render endpoint; use a virtual cable to avoid feedback).
      return OpenCaptureClassic(error);
    }
  } else if (!OpenCaptureClassic(error)) {
    return false;
  }
  return InitCaptureStream(error);
}

bool WasapiEngine::ActivateProcessLoopback(std::string* error) {
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  params.ProcessLoopbackParams.TargetProcessId =
      cfg_.excludePid ? cfg_.excludePid : GetCurrentProcessId();

  PROPVARIANT var;
  PropVariantInit(&var);
  var.vt = VT_BLOB;
  var.blob.cbSize = sizeof(params);
  var.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<ActivationHandler> handler = Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;
  // NOTE: unlike a heap PROPVARIANT, this blob points into our stack frame —
  // it must NOT be PropVariantClear()d (that would free the stack pointer).
  HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &var,
      handler.Get(), &asyncOp);
  if (FAILED(hr)) {
    if (error) {
      *error = "process-loopback activation failed (requires Windows 10 build 20348+); "
               "falling back to classic loopback (hr=" + std::to_string(hr) + ")";
    }
    return false;
  }
  if (!handler->Wait(5000)) {
    if (error) {
      *error = "process-loopback activation timed out; falling back to classic loopback";
    }
    return false;
  }
  hr = handler->result();
  if (FAILED(hr) || !handler->client()) {
    if (error) {
      *error = "process-loopback activation failed (requires Windows 10 build 20348+); "
               "falling back to classic loopback (hr=" + std::to_string(hr) + ")";
    }
    return false;
  }
  captureAudioClient_ = handler->client();
  return true;
}

bool WasapiEngine::OpenCaptureClassic(std::string* error) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerator)))) {
    if (error) *error = "MMDeviceEnumerator creation failed";
    return false;
  }

  ComPtr<IMMDevice> dev;
  HRESULT hr;
  if (cfg_.captureDeviceId.empty() || cfg_.captureDeviceId == "default") {
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  } else {
    hr = enumerator->GetDevice(Widen(cfg_.captureDeviceId).c_str(), &dev);
  }
  if (FAILED(hr)) {
    if (error) *error = "capture device not found";
    return false;
  }

  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                     reinterpret_cast<void**>(captureAudioClient_.GetAddressOf()));
  if (FAILED(hr)) {
    if (error) *error = "capture device Activate failed";
    return false;
  }
  return true;
}

bool WasapiEngine::InitCaptureStream(std::string* error) {
  HRESULT hr = captureAudioClient_->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      0, 0, &dspFormat_, nullptr);
  if (FAILED(hr)) {
    if (error) *error = "IAudioClient::Initialize(capture) failed: " + std::to_string(hr);
    return false;
  }
  if (FAILED(captureAudioClient_->GetService(IID_PPV_ARGS(&captureClient_)))) {
    if (error) *error = "GetService(IAudioCaptureClient) failed";
    return false;
  }
  if (FAILED(captureAudioClient_->SetEventHandle(captureEvent_))) {
    if (error) *error = "SetEventHandle(capture) failed";
    return false;
  }
  return true;
}

bool WasapiEngine::OpenRender(std::string* error) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerator)))) {
    if (error) *error = "MMDeviceEnumerator creation failed (render)";
    return false;
  }

  ComPtr<IMMDevice> dev;
  HRESULT hr;
  if (cfg_.renderDeviceId.empty() || cfg_.renderDeviceId == "default") {
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  } else {
    hr = enumerator->GetDevice(Widen(cfg_.renderDeviceId).c_str(), &dev);
  }
  if (FAILED(hr)) {
    if (error) *error = "render device not found";
    return false;
  }

  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                     reinterpret_cast<void**>(renderAudioClient_.GetAddressOf()));
  if (FAILED(hr)) {
    if (error) *error = "render device Activate failed";
    return false;
  }

  hr = renderAudioClient_->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
          AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      0, 0, &dspFormat_, nullptr);
  if (FAILED(hr)) {
    if (error) *error = "IAudioClient::Initialize(render) failed: " + std::to_string(hr);
    return false;
  }
  if (FAILED(renderAudioClient_->GetBufferSize(&renderBufFrames_))) {
    if (error) *error = "GetBufferSize(render) failed";
    return false;
  }
  if (FAILED(renderAudioClient_->GetService(IID_PPV_ARGS(&renderClient_)))) {
    if (error) *error = "GetService(IAudioRenderClient) failed";
    return false;
  }
  if (FAILED(renderAudioClient_->SetEventHandle(renderEvent_))) {
    if (error) *error = "SetEventHandle(render) failed";
    return false;
  }
  return true;
}

void WasapiEngine::AudioLoop() {
  // MMCSS registration for glitch resistance
  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  captureAudioClient_->Start();
  renderAudioClient_->Start();

  std::vector<float> inL, inR, outL, outR;

  while (!stop_) {
    HANDLE waits[2] = { captureEvent_, renderEvent_ };
    DWORD w = WaitForMultipleObjects(2, waits, FALSE, 200);
    if (w == WAIT_FAILED) break;

    // ---- drain every available capture packet (one wake can cover many) ----
    UINT32 packet = 0;
    while (!stop_ && SUCCEEDED(captureClient_->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      HRESULT hr = captureClient_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
          // Device changed — stop honestly; the host reports the state.
          stop_ = true;
        }
        break;
      }
      if (frames > 0) {
        inL.assign(frames, 0.f);
        inR.assign(frames, 0.f);
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data) {
          Deinterleave(data, frames, inL.data(), inR.data());
        }
        outL = inL;
        outR = inR;
        if (processCb_) {
          processCb_(outL, outR);  // synchronous JS DSP, in-place
        }
        FifoPush(outL, outR);
      }
      captureClient_->ReleaseBuffer(frames);
    }

    // ---- feed the render stream: FIFO frames first, silence after ----
    UINT32 padding = 0;
    if (FAILED(renderAudioClient_->GetCurrentPadding(&padding))) continue;
    UINT32 avail = renderBufFrames_ > padding ? renderBufFrames_ - padding : 0;
    if (avail == 0) continue;

    BYTE* out = nullptr;
    if (FAILED(renderClient_->GetBuffer(avail, &out)) || !out) continue;

    UINT32 n = (UINT32)std::min<size_t>(avail, FifoAvailable());
    if (n > 0) {
      Interleave(out, n, fifoL_.data() + fifoHead_, fifoR_.data() + fifoHead_);
      FifoConsume(n);
    }
    if (n < avail) {
      std::memset(out + (size_t)n * 8, 0, ((size_t)avail - n) * 8);
    }
    renderClient_->ReleaseBuffer(avail, n > 0 ? 0 : AUDCLNT_BUFFERFLAGS_SILENT);
  }

  captureAudioClient_->Stop();
  renderAudioClient_->Stop();
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
}

void WasapiEngine::FifoPush(const std::vector<float>& l, const std::vector<float>& r) {
  fifoL_.insert(fifoL_.end(), l.begin(), l.end());
  fifoR_.insert(fifoR_.end(), r.begin(), r.end());
  // Bound latency: keep at most one second of audio; drop oldest.
  size_t cap = (size_t)dspRate_;
  if (fifoL_.size() - fifoHead_ > cap) {
    size_t keepFrom = fifoL_.size() - cap;
    if (keepFrom > fifoHead_) FifoConsume(keepFrom - fifoHead_);
  }
}

void WasapiEngine::FifoConsume(size_t n) {
  fifoHead_ += n;
  if (fifoHead_ >= fifoL_.size()) {
    fifoL_.clear();
    fifoR_.clear();
    fifoHead_ = 0;
  } else if (fifoHead_ > (size_t)dspRate_ && fifoHead_ * 2 > fifoL_.size()) {
    fifoL_.erase(fifoL_.begin(), fifoL_.begin() + fifoHead_);
    fifoR_.erase(fifoR_.begin(), fifoR_.begin() + fifoHead_);
    fifoHead_ = 0;
  }
}

void WasapiEngine::Deinterleave(const BYTE* data, UINT32 frames, float* L, float* R) {
  const float* src = reinterpret_cast<const float*>(data);
  for (UINT32 i = 0; i < frames; ++i) {
    L[i] = src[i * 2];
    R[i] = src[i * 2 + 1];
  }
}

void WasapiEngine::Interleave(BYTE* data, UINT32 frames, const float* L, const float* R) {
  float* dst = reinterpret_cast<float*>(data);
  for (UINT32 i = 0; i < frames; ++i) {
    dst[i * 2] = L[i];
    dst[i * 2 + 1] = R[i];
  }
}

}  // namespace bt
