/**
 * Verify the INSTALLED plugin inside the desktop profile: the loader's own
 * resolution chain, the patch row, and that the copy on disk is the current
 * source (a stale copy is the failure mode that produced the first broken load).
 *
 * Run: node test-install.mjs [profile-dir]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const profile = resolve(process.argv[2]
  ?? process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop'));

console.log(`profile      = ${profile}`);
console.log(`source       = ${here}`);

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`); }
  catch (error) { fail++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

const installedRoot = join(profile, 'node_modules', 'dsh-update-plus');
const require = createRequire(join(profile, 'noop.cjs'));

// ---- the loader's resolution chain --------------------------------------
let resolvedManifest;
await check('the profile resolves the package by name', () => {
  const path = require.resolve('dsh-update-plus/package.json');
  assert.equal(resolve(path), resolve(join(installedRoot, 'package.json')));
  resolvedManifest = path;
});
await check('negative control: a package that is NOT installed does not resolve', () => {
  assert.throws(() => require.resolve('dsh-update-plus-not-a-real-package/package.json'));
});

const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
await check('the package declares a client half for the shell to scan', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  assert.ok(manifest.dsh.client.inject.length > 0);
});
await check('the client entry point resolves and exists', () => {
  assert.equal(typeof manifest.exports?.['./client'], 'string');
  const path = require.resolve('dsh-update-plus/client');
  assert.ok(existsSync(path), `missing: ${path}`);
});
await check('the host entry point resolves and exists', () => {
  const path = require.resolve('dsh-update-plus');
  assert.ok(existsSync(path), `missing: ${path}`);
});
await check('the bundled cordis patch resolves', () => {
  const path = require.resolve('dsh-update-plus/cordis.patch.yml');
  assert.ok(existsSync(path));
});
await check('every client package it declares actually exists', () => {
  // These are provided by the harness runtime, not by the profile, so they only
  // exist *inside* app.asar. That is only visible to a process with Electron's
  // asar layer active — reporting a plain-Node run as a failure would be a
  // false negative, and silently passing would be an "empty comparison".
  const asiLayerActive = (() => {
    try {
      const { statSync } = require('node:fs');
      return statSync('D:/DSH/resources/app.asar').isDirectory();
    } catch {
      return false;
    }
  })();
  if (!asiLayerActive) {
    console.log('      SKIP (asar layer inactive: run this under the host runtime to check)');
    return;
  }
  const runtimeNodeModules = 'D:/DSH/resources/app.asar/dsh/node_modules';
  for (const name of manifest.dsh.client.inject) {
    assert.ok(
      existsSync(join(runtimeNodeModules, ...name.split('/'), 'package.json')),
      `unresolvable client dependency: ${name}`,
    );
  }
});

// ---- the profile mount ---------------------------------------------------
// MEASURED: a plugin mounted by a hand-written `- insert:` patch row comes up
// `enabled: false` (the plugin manager treats a row it did not install as
// discovered-but-off), while a `dsh.profile.bundles` entry comes up enabled.
// This is the assertion that keeps the installer on the correct shape.
const profileJsonPath = join(profile, 'package.json');
const profileRaw = readFileSync(profileJsonPath, 'utf8');
const profileJson = JSON.parse(profileRaw);

await check('the profile manifest is intact UTF-8 (no mojibake from a bad editor)', () => {
  const replacement = (profileRaw.match(/\uFFFD/gu) ?? []).length;
  assert.equal(replacement, 0, `${replacement} replacement characters in package.json`);
});
await check('the plugin is a profile bundle exactly once', () => {
  const bundles = profileJson.dsh?.profile?.bundles ?? [];
  const count = bundles.filter(name => name === 'dsh-update-plus').length;
  assert.equal(count, 1, `found ${count} bundle entries`);
});
await check('the profile keeps the rest of its bundle list', () => {
  const bundles = profileJson.dsh?.profile?.bundles ?? [];
  assert.ok(bundles.length > 20, `only ${bundles.length} bundles left — the list looks truncated`);
  assert.ok(bundles.includes('dsh-builtin-browser'));
  assert.ok(bundles.includes('@deepseek-ai/dsh-web-app'));
});
await check('no legacy raw patch row is left behind (no double mount)', () => {
  const patchPath = join(profile, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return;
  const patch = readFileSync(patchPath, 'utf8');
  assert.ok(!patch.includes('dsh-update-plus (managed)'), 'the legacy managed block is still present');
  assert.ok(!/(^|\n)\s{4}-\s+id:\s*dsh-update-plus\s*(\n|$)/u.test(patch), 'a raw mount row is still present');
});
await check('no probe artifacts are left in the profile', () => {
  const patchPath = join(profile, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    assert.ok(!readFileSync(patchPath, 'utf8').includes('dsh-update-plus-probe'), 'probe row left in the patch');
  }
  assert.ok(!existsSync(join(profile, 'node_modules', 'dsh-update-plus-probe')), 'probe directory left behind');
});
await check('the profile patch still parses as YAML', async () => {
  const patchPath = join(profile, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return;
  // The profile's own yaml is used, so this is the same parser the loader runs.
  const yamlUrl = `file:///${join(profile, 'node_modules', 'yaml', 'dist', 'index.js').replace(/\\/gu, '/')}`;
  const YAML = (await import(yamlUrl)).default;
  const document = YAML.parse(readFileSync(patchPath, 'utf8'));
  assert.ok(Array.isArray(document), 'the patch is no longer a YAML sequence');
  assert.ok(document.length > 10, `only ${document.length} patch entries left`);
});

// ---- the copy is the current source -------------------------------------
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
await check('the installed copy is byte-identical to the current source', () => {
  const drift = [];
  for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/core.js']) {
    const left = join(here, file);
    const right = join(installedRoot, file);
    if (!existsSync(left) || !existsSync(right)) { drift.push(`${file}: missing`); continue; }
    if (hash(left) !== hash(right)) drift.push(`${file}: differs`);
  }
  assert.deepEqual(drift, [], `run install.mjs to refresh: ${drift.join('; ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
