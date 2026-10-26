#pragma once
/**
 * Minimal, self-contained C++ DSP for the BT APO (runs inside audiodg.exe).
 * Mirrors the parameter semantics of the JS engine/ DSP core:
 *   input gain → 10-band peaking/shelf EQ → output gain → soft limiter.
 * Real-time safe: no allocation, no locks, no I/O in Process().
 */
#include <cmath>
#include <cstdint>
#include <cstring>

namespace bt_apo {

struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  void setPeaking(float freq, float q, float gainDb, float sr) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w0 = 2.0f * 3.14159265358979f * freq / sr;
    const float alpha = std::sin(w0) / (2.0f * q);
    const float cw = std::cos(w0);
    const float a0 = 1 + alpha / A;
    b0 = (1 + alpha * A) / a0;
    b1 = (-2 * cw) / a0;
    b2 = (1 - alpha * A) / a0;
    a1 = (-2 * cw) / a0;
    a2 = (1 - alpha / A) / a0;
  }

  void setLowShelf(float freq, float gainDb, float sr) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w0 = 2.0f * 3.14159265358979f * freq / sr;
    const float cw = std::cos(w0);
    const float alpha = std::sin(w0) / 2.0f * std::sqrt(2.0f);
    const float s2 = 2 * std::sqrt(A) * alpha;
    const float a0 = A + 1 + (A - 1) * cw + s2;
    b0 = (A * ((A + 1) - (A - 1) * cw + s2)) / a0;
    b1 = (2 * A * ((A - 1) - (A + 1) * cw)) / a0;
    b2 = (A * ((A + 1) - (A - 1) * cw - s2)) / a0;
    a1 = (-2 * ((A - 1) + (A + 1) * cw)) / a0;
    a2 = ((A + 1) + (A - 1) * cw - s2) / a0;
  }

  void setHighShelf(float freq, float gainDb, float sr) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w0 = 2.0f * 3.14159265358979f * freq / sr;
    const float cw = std::cos(w0);
    const float alpha = std::sin(w0) / 2.0f * std::sqrt(2.0f);
    const float s2 = 2 * std::sqrt(A) * alpha;
    const float a0 = A + 1 - (A - 1) * cw + s2;
    b0 = (A * ((A + 1) + (A - 1) * cw + s2)) / a0;
    b1 = (-2 * A * ((A - 1) + (A + 1) * cw)) / a0;
    b2 = (A * ((A + 1) + (A - 1) * cw - s2)) / a0;
    a1 = (2 * ((A - 1) - (A + 1) * cw)) / a0;
    a2 = ((A + 1) - (A - 1) * cw - s2) / a0;
  }

  float process(float x) {
    const float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }

  void reset() { x1 = x2 = y1 = y2 = 0; }
};

struct EqBand {
  float freq, q, gainDb;
  int type;  // 0=peaking 1=lowshelf 2=highshelf
  bool enabled;
};

struct ApoParams {
  float inputGainDb = 0;
  float outputGainDb = 0;
  EqBand bands[10] = {
    {31, 1, 0, 0, true},   {62, 1, 0, 0, true},   {125, 1, 0, 0, true},
    {250, 1, 0, 0, true},  {500, 1, 0, 0, true},  {1000, 1, 0, 0, true},
    {2000, 1, 0, 0, true}, {4000, 1, 0, 0, true}, {8000, 1, 0, 0, true},
    {16000, 1, 0, 0, true}
  };
  float limiterCeilingDb = -1.0f;
  bool bypass = false;
};

class ApoDsp {
 public:
  void configure(const ApoParams& p, float sampleRate, int channels) {
    params_ = p;
    sr_ = sampleRate;
    ch_ = channels > 2 ? 2 : channels;
    for (int c = 0; c < 2; ++c) {
      for (int i = 0; i < 10; ++i) {
        auto& f = eq_[c][i];
        const auto& b = p.bands[i];
        if (!b.enabled || std::fabs(b.gainDb) < 1e-6f) {
          f = Biquad{};
          continue;
        }
        switch (b.type) {
          case 1: f.setLowShelf(b.freq, b.gainDb, sr_); break;
          case 2: f.setHighShelf(b.freq, b.gainDb, sr_); break;
          default: f.setPeaking(b.freq, b.q > 0.05f ? b.q : 0.707f, b.gainDb, sr_); break;
        }
      }
    }
    inGain_ = std::pow(10.0f, p.inputGainDb / 20.0f);
    outGain_ = std::pow(10.0f, p.outputGainDb / 20.0f);
    ceiling_ = std::pow(10.0f, p.limiterCeilingDb / 20.0f);
  }

  // interleaved float32, frames × channels
  void process(float* interleaved, int frames) {
    if (params_.bypass) return;
    for (int i = 0; i < frames; ++i) {
      float l = interleaved[i * ch_] * inGain_;
      float r = ch_ > 1 ? interleaved[i * ch_ + 1] * inGain_ : l;
      for (int b = 0; b < 10; ++b) {
        l = eq_[0][b].process(l);
        if (ch_ > 1) r = eq_[1][b].process(r);
      }
      l *= outGain_;
      r *= outGain_;
      // soft-then-hard limiter (per-sample, stateful gain)
      const float peak = std::fabs(l) > std::fabs(r) ? std::fabs(l) : std::fabs(r);
      const float target = peak > ceiling_ ? ceiling_ / peak : 1.0f;
      limiterGain_ = target < limiterGain_ ? target : (limiterGain_ * 0.99995f + target * 0.00005f);
      if (limiterGain_ > 1.0f) limiterGain_ = 1.0f;
      l *= limiterGain_;
      r *= limiterGain_;
      if (l > ceiling_) l = ceiling_;
      if (l < -ceiling_) l = -ceiling_;
      if (r > ceiling_) r = ceiling_;
      if (r < -ceiling_) r = -ceiling_;
      interleaved[i * ch_] = l;
      if (ch_ > 1) interleaved[i * ch_ + 1] = r;
    }
  }

 private:
  ApoParams params_;
  float sr_ = 48000;
  int ch_ = 2;
  Biquad eq_[2][10];
  float inGain_ = 1, outGain_ = 1, ceiling_ = 0.891f, limiterGain_ = 1;
};

}  // namespace bt_apo
