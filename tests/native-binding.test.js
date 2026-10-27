/**
 * Regression tests for the native build wiring (native/wasapi/binding.gyp).
 *
 * Why this exists: node-gyp's msvs generator copies include_dirs verbatim into
 * the vcxproj's AdditionalIncludeDirectories, which MSBuild resolves against
 * the project (build/) directory — a cwd-relative include therefore breaks the
 * compile with "C1083: Cannot open include file: 'napi.h'". gyp additionally
 * passes `<!@` command output through POSIX shlex.split(), which eats the
 * backslashes of unquoted Windows paths. The node-addon-api include expansion
 * must therefore print an absolute, double-quoted path (require(...).include,
 * NOT the cwd-relative .include_dir) and must not depend on the directory gyp
 * happens to run it from.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasapiDir = path.join(root, 'native', 'wasapi');

function readBindingGyp() {
  return JSON.parse(fs.readFileSync(path.join(wasapiDir, 'binding.gyp'), 'utf8'));
}

function collectIncludeDirs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectIncludeDirs(item, out);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.include_dirs)) out.push(...node.include_dirs);
    for (const value of Object.values(node)) collectIncludeDirs(value, out);
  }
  return out;
}

function nodeAddonApiEntries() {
  return collectIncludeDirs(readBindingGyp()).filter((e) => e.includes('node-addon-api'));
}

/** Emulates gyp's shlex.split() for the single-token quoted-path case we allow. */
function gypSplit(output) {
  const trimmed = output.replace(/\r?\n$/, '');
  if (/^".*"$/.test(trimmed)) return [trimmed.slice(1, -1)];
  return trimmed.split(/\s+/).filter(Boolean);
}

function runIncludeExpansion(entry, cwd) {
  const m = /^<!@\(node -p "(.+)"\)$/.exec(entry);
  assert.ok(m, `unexpected include_dirs entry shape: ${entry}`);
  const stdout = execFileSync(process.execPath, ['-p', m[1]], { cwd, encoding: 'utf8' });
  return gypSplit(stdout);
}

test('binding.gyp uses the absolute .include recipe in every OS branch', () => {
  const entries = nodeAddonApiEntries();
  assert.ok(entries.length >= 2, 'both OS branches must wire node-addon-api');
  for (const entry of entries) {
    assert.equal(
      entry,
      '<!@(node -p "require(\'node-addon-api\').include")',
      'must use .include (absolute + quoted); .include_dir is cwd-relative and breaks MSBuild'
    );
    assert.ok(!entry.includes('include_dir'), 'the cwd-relative include_dir must never come back');
  }
});

test('the include expansion is absolute and contains napi.h', () => {
  for (const entry of nodeAddonApiEntries()) {
    for (const cwd of [wasapiDir, root]) {
      const tokens = runIncludeExpansion(entry, cwd);
      assert.equal(tokens.length, 1, `expected one include token, got: ${JSON.stringify(tokens)}`);
      assert.ok(path.isAbsolute(tokens[0]), `include dir must be absolute, got: ${tokens[0]}`);
      assert.ok(
        fs.existsSync(path.join(tokens[0], 'napi.h')),
        `napi.h not found in ${tokens[0]} — run "npm install"`
      );
    }
  }
});

test('the include expansion does not depend on the invoking cwd', () => {
  for (const entry of nodeAddonApiEntries()) {
    const fromWasapiDir = runIncludeExpansion(entry, wasapiDir);
    const fromRoot = runIncludeExpansion(entry, root);
    assert.deepEqual(
      fromWasapiDir,
      fromRoot,
      'include path must not change with cwd (the include_dir bug)'
    );
  }
});
