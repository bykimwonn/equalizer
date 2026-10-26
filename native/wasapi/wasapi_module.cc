/**
 * bt_wasapi N-API bindings.
 *
 * Exports (consumed by electron/audio/backends.js):
 *   enumerateDevices() -> [{id,name,isRender,isCapture,isDefault,loopbackSupported,sampleRates,channels}]
 *   startStream({
 *     captureDeviceId, captureMode, excludePid, renderDeviceId,
 *     sampleRate, blockFrames, channels,
 *     process: (L: Float32Array, R: Float32Array) => void   // in-place DSP
 *   }) -> { stop() }
 */
#include <napi.h>

#include <memory>
#include <string>
#include <vector>

#include "wasapi_engine.h"

namespace {

Napi::Value EnumerateDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto devices = bt::EnumerateDevices();
  Napi::Array arr = Napi::Array::New(env, devices.size());
  for (size_t i = 0; i < devices.size(); ++i) {
    const auto& d = devices[i];
    Napi::Object o = Napi::Object::New(env);
    o.Set("id", Napi::String::New(env, d.id));
    o.Set("name", Napi::String::New(env, d.name));
    o.Set("isRender", Napi::Boolean::New(env, d.isRender));
    o.Set("isCapture", Napi::Boolean::New(env, d.isCapture));
    o.Set("isDefault", Napi::Boolean::New(env, d.isDefault));
    o.Set("loopbackSupported", Napi::Boolean::New(env, d.loopbackSupported));
    Napi::Array rates = Napi::Array::New(env, d.sampleRates.size());
    for (size_t r = 0; r < d.sampleRates.size(); ++r) {
      rates.Set((uint32_t)r, Napi::Number::New(env, d.sampleRates[r]));
    }
    o.Set("sampleRates", rates);
    o.Set("channels", Napi::Number::New(env, d.channels));
    arr.Set((uint32_t)i, o);
  }
  return arr;
}

Napi::Value StartStream(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "startStream requires an options object").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object opts = info[0].As<Napi::Object>();

  bt::StreamConfig cfg;
  if (opts.Has("captureDeviceId") && opts.Get("captureDeviceId").IsString())
    cfg.captureDeviceId = opts.Get("captureDeviceId").As<Napi::String>().Utf8Value();
  if (opts.Has("captureMode") && opts.Get("captureMode").IsString())
    cfg.captureMode = opts.Get("captureMode").As<Napi::String>().Utf8Value();
  if (opts.Has("renderDeviceId") && opts.Get("renderDeviceId").IsString())
    cfg.renderDeviceId = opts.Get("renderDeviceId").As<Napi::String>().Utf8Value();
  if (opts.Has("excludePid") && opts.Get("excludePid").IsNumber())
    cfg.excludePid = opts.Get("excludePid").As<Napi::Number>().Uint32Value();
  if (opts.Has("sampleRate") && opts.Get("sampleRate").IsNumber())
    cfg.sampleRate = opts.Get("sampleRate").As<Napi::Number>().Int32Value();
  if (opts.Has("blockFrames") && opts.Get("blockFrames").IsNumber())
    cfg.blockFrames = opts.Get("blockFrames").As<Napi::Number>().Int32Value();
  if (opts.Has("channels") && opts.Get("channels").IsNumber())
    cfg.channels = opts.Get("channels").As<Napi::Number>().Int32Value();

  if (!opts.Has("process") || !opts.Get("process").IsFunction()) {
    Napi::TypeError::New(env, "startStream requires a process callback").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto engine = std::make_shared<bt::WasapiEngine>();
  auto tsfn = Napi::ThreadSafeFunction::New(
      env, opts.Get("process").As<Napi::Function>(), "bt_wasapi_process",
      0 /* unlimited queue */, 1 /* initial thread */);

  // Synchronous hand-off: the audio thread blocks on the TSFN call while the JS
  // process callback runs on the main loop — deterministic and safe.
  engine->SetProcessCallback([tsfn](std::vector<float>& L, std::vector<float>& R) {
    auto* payload = new std::pair<std::vector<float>, std::vector<float>>(L, R);
    auto* ok = new bool(false);
    tsfn.BlockingCall(payload, [ok](Napi::Env env, Napi::Function js,
                                    std::pair<std::vector<float>, std::vector<float>>* p) {
      Napi::ArrayBuffer abL = Napi::ArrayBuffer::New(env, p->first.data(), p->first.size() * sizeof(float));
      Napi::ArrayBuffer abR = Napi::ArrayBuffer::New(env, p->second.data(), p->second.size() * sizeof(float));
      Napi::Float32Array fL = Napi::Float32Array::New(env, p->first.size(), abL, 0);
      Napi::Float32Array fR = Napi::Float32Array::New(env, p->second.size(), abR, 0);
      js.Call({fL, fR});
      *ok = true;
    });
    // L/R were processed in place via the typed-array views into *payload
    L = std::move(payload->first);
    R = std::move(payload->second);
    delete payload;
    delete ok;
  });

  std::string error;
  if (!engine->Start(cfg, &error)) {
    tsfn.Release();
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object handle = Napi::Object::New(env);
  auto* rawEngine = new std::shared_ptr<bt::WasapiEngine>(engine);
  handle.Set("stop", Napi::Function::New(env, [rawEngine, tsfn](const Napi::CallbackInfo& ci) {
    (*rawEngine)->Stop();
    tsfn.Release();
    delete rawEngine;
    return ci.Env().Undefined();
  }));
  return handle;
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("enumerateDevices", Napi::Function::New(env, EnumerateDevices));
  exports.Set("startStream", Napi::Function::New(env, StartStream));
  exports.Set("platformSupported", Napi::Boolean::New(env, true));
  return exports;
}

}  // namespace

NODE_API_MODULE(bt_wasapi, InitModule)
