/**
 * Syntax gate for plain-JS sources (engine/, electron/, scripts/, tests/).
 * JSX is validated by the Vite production build ("npm run build").
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['engine', 'electron', 'scripts', 'tests'];
let checked = 0;
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.mjs')) {
      checked++;
      try {
        const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
        if (r.status !== 0) failures.push(`${p}: ${r.stderr}`);
      } catch (e) {
        failures.push(`${p}: ${e.message}`);
      }
    }
  }
}

for (const t of targets) walk(path.join(root, t));

if (failures.length) {
  console.error(`lint: ${failures.length} file(s) failed syntax check`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`lint: ${checked} files passed syntax check`);
