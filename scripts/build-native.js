/**
 * Builds the native WASAPI addon (Windows only — honest failure elsewhere).
 * Uses the locally installed node-gyp (devDependency) — no PATH assumptions.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

if (os.platform() !== 'win32') {
  console.error(
    [
      'bt_wasapi can only be built on Windows (WASAPI + Windows SDK).',
      `Current platform: ${os.platform()}.`,
      'On Windows: install VS Build Tools + Windows SDK, then run "npm run build:native" again.',
      'The application still runs with the simulation backend (clearly labeled) for development.'
    ].join('\n')
  );
  process.exit(1);
}

let gypBin;
try {
  gypBin = require.resolve('node-gyp/bin/node-gyp.js');
} catch {
  console.error('node-gyp not found in node_modules — run "npm install" first.');
  process.exit(1);
}

// Preflight: fail fast with an honest message if the exact include dir that
// binding.gyp resolves (require('node-addon-api').include) is missing, instead
// of letting MSBuild burn minutes and die on "C1083: napi.h".
let napiInclude;
try {
  napiInclude = path.dirname(require.resolve('node-addon-api/package.json'));
} catch {
  console.error('node-addon-api not found in node_modules — run "npm install" first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(napiInclude, 'napi.h'))) {
  console.error(
    `node-addon-api resolved to ${napiInclude} but napi.h is missing there — run "npm install" to repair node_modules.`
  );
  process.exit(1);
}
console.log(`node-addon-api include dir: ${napiInclude}`);

const r = spawnSync(process.execPath, [gypBin, 'configure', 'build'], {
  cwd: path.join(root, 'native', 'wasapi'),
  stdio: 'inherit'
});
process.exit(r.status ?? 1);
