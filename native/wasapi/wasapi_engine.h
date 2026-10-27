#pragma once
/**
 * bt_wasapi engine interface (Windows).
 */
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <windows.h>
#include <mmreg.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

namespace bt {

using Microsoft::WRL::ComPtr;

struct DeviceInfo {
  std::string id;
  std::string name;
  bool isRender = false;
  bool isCapture = false;
  bool isDefault = false;
  bool loopbackSupported = false;
  std::vector<int> sampleRates;
  int channels = 2;
};

struct StreamConfig {
  std::string captureDeviceId;   // "default" or endpoint id (classic loopback)
  std::string captureMode;       // "process-loopback" | "loopback"
  std::string renderDeviceId;    // "default" or endpoint id
  uint32_t excludePid = 0;       // process tree excluded from process-loopback
  int sampleRate = 48000;
  int blockFrames = 256;
  int channels = 2;
};

class WasapiEngine {
 public:
  using ProcessCallback = std::function<void(std::vector<float>&, std::vector<float>&)>;

  WasapiEngine();
  ~WasapiEngine();

  void SetProcessCallback(ProcessCallback cb);
  bool Start(const StreamConfig& cfg, std::string* error);
  void Stop();
  bool running() const { return running_; }

 private:
  bool OpenCapture(std::string* error);
  bool ActivateProcessLoopback(std::string* error);
  bool OpenCaptureClassic(std::string* error);
  bool InitCaptureStream(std::string* error);
  bool OpenRender(std::string* error);
  void AudioLoop();
  void Cleanup();

  // Processed-audio staging FIFO (planar L/R), consumed by the render side.
  void FifoPush(const std::vector<float>& l, const std::vector<float>& r);
  size_t FifoAvailable() const { return fifoL_.size() - fifoHead_; }
  void FifoConsume(size_t n);

  // Fixed DSP format: float32 interleaved stereo; the audio engine converts
  // to/from each endpoint's mix format (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM).
  static void Deinterleave(const BYTE* data, UINT32 frames, float* L, float* R);
  static void Interleave(BYTE* data, UINT32 frames, const float* L, const float* R);

  std::mutex mutex_;
  StreamConfig cfg_;
  ProcessCallback processCb_;
  std::atomic<bool> stop_{false};
  bool running_ = false;
  std::thread audioThread_;

  ComPtr<IAudioClient> captureAudioClient_;
  ComPtr<IAudioCaptureClient> captureClient_;
  ComPtr<IAudioClient> renderAudioClient_;
  ComPtr<IAudioRenderClient> renderClient_;
  HANDLE captureEvent_ = nullptr;
  HANDLE renderEvent_ = nullptr;

  WAVEFORMATEX dspFormat_{};
  int dspRate_ = 48000;
  UINT32 renderBufFrames_ = 0;

  std::vector<float> fifoL_;
  std::vector<float> fifoR_;
  size_t fifoHead_ = 0;
};

std::vector<DeviceInfo> EnumerateDevices();

}  // namespace bt
