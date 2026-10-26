/**
 * Non-Windows stub so `require('bt_wasapi.node')` fails gracefully with a
 * clear message on other platforms (the JS layer also checks os.platform()).
 */
#include <napi.h>

static Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(),
                   "bt_wasapi is only available on Windows. "
                   "Use the simulation backend or run on a Windows machine.")
      .ThrowAsJavaScriptException();
  return info.Env().Null();
}

static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("enumerateDevices", Napi::Function::New(env, Unsupported));
  exports.Set("startStream", Napi::Function::New(env, Unsupported));
  exports.Set("platformSupported", Napi::Boolean::New(env, false));
  return exports;
}

NODE_API_MODULE(bt_wasapi, InitModule)
