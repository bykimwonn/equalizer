import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicationRisk } from '../electron/audio/engine-host.js';

test('process-loopback routing raises the same-device duplication warning', () => {
  const risk = duplicationRisk('process-loopback');
  assert.ok(risk, 'process-loopback must carry a duplication warning');
  assert.equal(risk.kind, 'same-device-doubling');
  // The message must honestly say tap-not-reroute and name the clean paths.
  assert.match(risk.message, /tap, not a reroute/i);
  assert.match(risk.message, /virtual cable/i);
  assert.match(risk.message, /APO/i);
  // It must correct the bypass misconception: bypass keeps the doubled signal.
  assert.match(risk.message, /press Stop/i);
});

test('single-path routing modes carry no duplication warning', () => {
  assert.equal(duplicationRisk('loopback-to-cable'), null);
  assert.equal(duplicationRisk('apo'), null);
});
