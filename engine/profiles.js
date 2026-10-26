/**
 * Sound profiles — each profile maps to concrete DSP settings.
 * No genre certainty is claimed anywhere: profiles are listening-intent presets.
 */
import { defaultSettings } from './dsp/chain.js';

function make(id, name, description, mutate) {
  const settings = defaultSettings();
  mutate(settings);
  return Object.freeze({ id, name, description, settings: Object.freeze(settings) });
}

/** Apply per-band gain helper for the 10-band graphic layout. */
function eqGains(settings, gains) {
  settings.eq.bands = settings.eq.bands.map((b, i) => ({ ...b, gainDb: gains[i] ?? 0 }));
}

export const PROFILES = Object.freeze([
  make('balanced', 'Balanced', 'Neutral reference with gentle protection.', (s) => {
    eqGains(s, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    s.bass.harmonics = 0.2;
    s.limiter.enabled = true;
    s.limiter.ceilingDb = -1;
  }),
  make('bass-boost', 'Bass Boost', 'Controlled low-shelf lift with sub presence.', (s) => {
    eqGains(s, [2.5, 2, 1, 0, 0, 0, 0, 0, 0, 0]);
    s.bass.gainDb = 2.5;
    s.bass.subGainDb = 1.5;
    s.bass.harmonics = 0.35;
    s.limiter.ceilingDb = -1.5;
  }),
  make('deep-bass', 'Deep Bass', 'Sub-focused enhancement with harmonic support and heavy protection.', (s) => {
    eqGains(s, [3.5, 2.5, 1, -0.5, 0, 0, 0, 0, 0, 0]);
    s.bass.gainDb = 3;
    s.bass.subGainDb = 3;
    s.bass.harmonics = 0.55;
    s.bass.protection = true;
    s.limiter.ceilingDb = -2;
  }),
  make('vocal-clarity', 'Vocal Clarity', 'Presence lift for intelligibility, tame low mud.', (s) => {
    eqGains(s, [-1, -1, -0.5, 0, 1, 2.5, 3, 1.5, 0, 0]);
    s.clarity.presenceDb = 3;
    s.clarity.airDb = 1;
    s.clarity.transients = 0.4;
    s.bass.gainDb = -1;
  }),
  make('acoustic', 'Acoustic', 'Natural instruments, gentle air, minimal processing.', (s) => {
    eqGains(s, [0, 0.5, 0.5, 0, 0, 0.5, 1, 1, 1.5, 1]);
    s.bass.harmonics = 0.15;
    s.clarity.airDb = 1.5;
    s.clarity.transients = 0.25;
  }),
  make('classical', 'Classical', 'Wide, uncompressed dynamics with refined top end.', (s) => {
    eqGains(s, [0, 0, 0, -0.5, 0, 0, 0.5, 1, 1, 1.5]);
    s.stereo.width = 1.15;
    s.compressor.enabled = false;
    s.bass.harmonics = 0.1;
    s.clarity.airDb = 1;
  }),
  make('rock', 'Rock', 'Punchy mids and controlled low end.', (s) => {
    eqGains(s, [1, 1, 0.5, -0.5, 0, 1, 1.5, 1, 1, 0.5]);
    s.compressor.enabled = true;
    s.compressor.thresholdDb = -20;
    s.compressor.ratio = 2.5;
    s.compressor.makeupDb = 2;
    s.bass.gainDb = 1;
    s.clarity.presenceDb = 1.5;
  }),
  make('hip-hop', 'Hip-Hop', 'Deep lows with crisp transients.', (s) => {
    eqGains(s, [3, 2.5, 1, 0, -0.5, 0, 1, 1.5, 1, 0.5]);
    s.bass.gainDb = 2.5;
    s.bass.subGainDb = 2;
    s.bass.harmonics = 0.45;
    s.clarity.transients = 0.45;
    s.compressor.enabled = true;
    s.compressor.thresholdDb = -18;
    s.compressor.ratio = 3;
    s.limiter.ceilingDb = -1.5;
  }),
  make('electronic', 'Electronic', 'Wide image, extended top, controlled bass punch.', (s) => {
    eqGains(s, [2, 1.5, 0.5, -1, -0.5, 0, 1, 2, 2, 1.5]);
    s.stereo.width = 1.25;
    s.bass.gainDb = 1.5;
    s.bass.harmonics = 0.4;
    s.clarity.airDb = 2;
    s.compressor.enabled = true;
    s.compressor.multiband = true;
    s.compressor.crossoverHz = 200;
    s.compressor.thresholdDb = -18;
    s.compressor.ratio = 3;
  }),
  make('jazz', 'Jazz', 'Warm mids, open dynamics, natural space.', (s) => {
    eqGains(s, [0.5, 1, 1, 0.5, 0, 0.5, 1, 0.5, 0.5, 1]);
    s.bass.harmonics = 0.2;
    s.clarity.presenceDb = 1;
    s.stereo.width = 1.1;
    s.compressor.enabled = false;
  }),
  make('podcast', 'Podcast', 'Speech-first: compression, presence, low cut.', (s) => {
    eqGains(s, [-3, -2, -1, 0, 1, 3, 3, 2, 1, 0]);
    s.compressor.enabled = true;
    s.compressor.thresholdDb = -22;
    s.compressor.ratio = 4;
    s.compressor.attackMs = 5;
    s.compressor.releaseMs = 150;
    s.compressor.makeupDb = 3;
    s.clarity.presenceDb = 3;
    s.clarity.transients = 0.3;
    s.bass.gainDb = -2;
    s.limiter.ceilingDb = -2;
  }),
  make('gaming', 'Gaming', 'Footstep presence and spatial cues with safe dynamics.', (s) => {
    eqGains(s, [1, 0.5, 0, -0.5, 1, 2, 2.5, 2, 1.5, 1]);
    s.clarity.presenceDb = 2.5;
    s.clarity.transients = 0.5;
    s.stereo.width = 1.2;
    s.compressor.enabled = true;
    s.compressor.thresholdDb = -20;
    s.compressor.ratio = 2.5;
  }),
  make('movie', 'Movie', 'Cinematic low end, dialog clarity, controlled peaks.', (s) => {
    eqGains(s, [2.5, 2, 1, 0, 1, 2, 2, 1, 0.5, 0.5]);
    s.bass.gainDb = 2;
    s.bass.subGainDb = 2;
    s.bass.harmonics = 0.4;
    s.compressor.enabled = true;
    s.compressor.multiband = true;
    s.compressor.crossoverHz = 250;
    s.compressor.thresholdDb = -20;
    s.compressor.ratio = 3;
    s.compressor.makeupDb = 2;
    s.clarity.presenceDb = 2;
    s.stereo.width = 1.15;
    s.limiter.ceilingDb = -1.5;
  }),
  make('night', 'Night Listening', 'Soft, limited, comfortable late-night listening.', (s) => {
    eqGains(s, [1, 1, 0.5, 0, 0, 0.5, -0.5, -1, -1.5, -2]);
    s.compressor.enabled = true;
    s.compressor.thresholdDb = -24;
    s.compressor.ratio = 3.5;
    s.compressor.makeupDb = 2;
    s.clarity.presenceDb = 1;
    s.bass.gainDb = 1;
    s.outputGainDb = -3;
    s.limiter.ceilingDb = -6;
    s.loudness.normalization = true;
    s.loudness.targetLufs = -20;
    s.loudness.maxGainDb = 4;
  }),
  make('custom', 'Custom Profile', 'User-defined settings (created in the Sound Profiles screen).', (s) => {
    eqGains(s, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  })
]);

export function getProfile(id) {
  return PROFILES.find((p) => p.id === id) || PROFILES[0];
}

/** Deep-cloned settings of a profile so callers can mutate freely. */
export function profileSettings(id) {
  const p = getProfile(id);
  return JSON.parse(JSON.stringify(p.settings));
}
