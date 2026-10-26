/**
 * Builds the native WASAPI addon (Windows only — honest failure elsewhere).
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const r = spawnSync('node-gyp', ['configure', 'build'], {
  cwd: path.join(root, 'native', 'wasapi'),
  stdio: 'inherit',
  shell: true
});
process.exit(r.status ?? 1);
