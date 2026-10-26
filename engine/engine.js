/**
 * AudioEngine — orchestrates the DSP chain + analysis over real PCM blocks.
 * Used by the Electron main process (native WASAPI buffers) and by tests
 * (generated signals). Real-time safety: no allocation in process() beyond
 * reading; telemetry snapshots copy out small arrays only.
 */
import { DspChain, defaultSettings } from './dsp/chain.js';
import { FeatureExtractor } from './analysis/features.js';

export class AudioEngine {
  constructor({ sampleRate = 48000, blockFrames = 256, settings = defaultSettings() } = {}) {
    this.sampleRate = sampleRate;
    this.blockFrames = blockFrames;
    this.chain = new DspChain(sampleRate, settings);
    this.features = new FeatureExtractor(sampleRate);
    this.blocksProcessed = 0;
    this.clipEvents = 0;
    this.underruns = 0;
    this.nanGuardTrips = 0;
    this.totalFrames = 0;
    this.processTimeMs = 0;
    this.lastBlockMs = 0;
    this.startedAt = Date.now();
    // meter smoothers
    this.inputPeak = 0;
    this.outputPeak = 0;
    this.inputRmsDb = -160;
    this.outputRmsDb = -160;
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this.chain.setSampleRate(sampleRate);
    this.features.setSampleRate(sampleRate);
  }

  setSettings(settings) {
    this.chain.setSettings(settings);
  }

  getSettings() {
    return this.chain.getSettings();
  }

  setBypass(bypass) {
    const s = this.chain.getSettings();
    s.bypass = !!bypass;
    this.chain.setSettings(s);
  }

  /**
   * Process one stereo block in-place (Float32Array).
   * @returns {{clamps:number, gainReductionDb:number, blockMs:number}}
   */
  process(L, R = L, offset = 0, len = L.length - offset) {
    const t0 = performance.now();

    // input analysis (pre-chain)
    this.features.processBlock(L, R, offset, len);

    let inPeak = 0;
    let inSum = 0;
    for (let i = offset; i < offset + len; i++) {
      const v = Math.max(Math.abs(L[i]), R === L ? 0 : Math.abs(R[i]));
      if (v > inPeak) inPeak = v;
      inSum += L[i] * L[i];
    }
    this.inputPeak = Math.max(inPeak, this.inputPeak * 0.85);
    const inRms = Math.sqrt(inSum / Math.max(1, len));
    if (inRms > 1e-8) {
      const db = 20 * Math.log10(inRms);
      this.inputRmsDb = this.inputRmsDb < -150 ? db : 0.85 * this.inputRmsDb + 0.15 * db;
    }

    // NaN/Inf guard — never propagate garbage into the device
    for (let i = offset; i < offset + len; i++) {
      if (!Number.isFinite(L[i])) {
        L[i] = 0;
        this.nanGuardTrips++;
      }
      if (R !== L && !Number.isFinite(R[i])) {
        R[i] = 0;
        this.nanGuardTrips++;
      }
    }

    // feed loudness estimate to the chain for optional normalization
    this.chain.setLoudnessEstimate(this.features.latest.loudnessLufs);

    const res = this.chain.processBlock(L, R, offset, len);

    // output meters
    let outPeak = 0;
    let outSum = 0;
    for (let i = offset; i < offset + len; i++) {
      const v = Math.max(Math.abs(L[i]), R === L ? 0 : Math.abs(R[i]));
      if (v > outPeak) outPeak = v;
      outSum += L[i] * L[i];
    }
    this.outputPeak = Math.max(outPeak, this.outputPeak * 0.85);
    const outRms = Math.sqrt(outSum / Math.max(1, len));
    if (outRms > 1e-8) {
      const db = 20 * Math.log10(outRms);
      this.outputRmsDb = this.outputRmsDb < -150 ? db : 0.85 * this.outputRmsDb + 0.15 * db;
    }

    this.blocksProcessed++;
    this.totalFrames += len;
    this.clipEvents = this.features.latest.clipCount;
    const blockMs = performance.now() - t0;
    this.lastBlockMs = blockMs;
    this.processTimeMs += blockMs;
    return { ...res, blockMs };
  }

  /**
   * Compact telemetry snapshot for the UI (≈30 Hz push).
   * Numbers only; spectrum decimated to 64 log bands.
   */
  getTelemetry() {
    const f = this.features.latest;
    const durationSec = this.totalFrames / Math.max(1, this.sampleRate);
    return {
      engine: {
        sampleRate: this.sampleRate,
        blockFrames: this.blockFrames,
        blocksProcessed: this.blocksProcessed,
        uptimeSec: (Date.now() - this.startedAt) / 1000,
        clipEvents: this.clipEvents,
        underruns: this.underruns,
        nanGuardTrips: this.nanGuardTrips,
        // measured processing cost — not a fabricated device latency
        avgProcessMsPerBlock: this.blocksProcessed > 0 ? this.processTimeMs / this.blocksProcessed : 0,
        lastBlockMs: this.lastBlockMs,
        // block scheduling latency estimate (real-time path duration of one block)
        blockLatencyMs: (this.blockFrames / Math.max(1, this.sampleRate)) * 1000
      },
      input: {
        peak: this.inputPeak,
        rmsDb: this.inputRmsDb
      },
      output: {
        peak: this.outputPeak,
        rmsDb: this.outputRmsDb
      },
      features: {
        rmsDb: f.rmsDb,
        peakDb: f.peakDb,
        crestDb: f.crestDb,
        bandEnergiesDb: f.bandEnergiesDb,
        spectralCentroidHz: f.spectralCentroidHz,
        rolloff85Hz: f.rolloff85Hz,
        spectralFlux: f.spectralFlux,
        loudnessLufs: f.loudnessLufs,
        clipCount: f.clipCount
      },
      spectrum: Array.from(this.features.spectrumSnapshot(64)),
      limiter: {
        clamps: this.chain.lastLimiterClamps,
        gainReductionDb: this.chain.lastGainReductionDb
      },
      durationSec
    };
  }
}
