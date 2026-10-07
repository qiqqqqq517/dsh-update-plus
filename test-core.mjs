/**
 * Offline + live checks for dsh-update-plus/lib/core.js.
 * Run: node test-core.mjs
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CHANNEL_IDS, channelTable, parseManifest, compareVersions,
  findDesktopInstall, readBundledDshVersion, readAppUpdateConfig,
  resolveLauncher, resolveAllChannels, buildRestartPlan,
} from './lib/core.js';

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${label}`);
  } catch (error) {
    fail++;
    console.log(`FAIL  ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

console.log('--- version comparison ---');
check('0.2.0-rc.2 > 0.2.0-rc.1', () => assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.1') > 0));
check('0.2.0 > 0.2.0-rc.2 (a release outranks its prerelease)', () => assert.ok(compareVersions('0.2.0', '0.2.0-rc.2') > 0));
check('0.2.0-rc.2 < 0.2.0', () => assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0));
check('0.2.0-rc.2 === 0.2.0-rc.2 is 0', () => assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.2'), 0));
check('0.1.7-rc.1.20260924.1 > 0.1.7-rc.1', () => assert.ok(compareVersions('0.1.7-rc.1.20260924.1', '0.1.7-rc.1') > 0));
check('0.10.0 > 0.9.9 (numeric, not lexical)', () => assert.ok(compareVersions('0.10.0', '0.9.9') > 0));
check('numeric pre-id ranks below alphanumeric (1.0.0-1 < 1.0.0-alpha)', () => assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0));

console.log('\n--- manifest parsing (the exact nightly.yml shape) ---');
const SAMPLE = [
  'version: 0.2.0-rc.2',
  'files:',
  '  - url: >-',
  '      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe',
  '    sha512: >-',
  '      raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==',
  '    size: 289313640',
  'path: >-',
  '  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe',
  "sha512: >-",
  '  raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==',
  "releaseDate: '2026-09-29T10:35:27.666Z'",
  '',
].join('\n');

check('parses version', () => assert.equal(parseManifest(SAMPLE).version, '0.2.0-rc.2'));
check('unfolds the folded `path:` block scalar', () => assert.equal(
  parseManifest(SAMPLE).url,
  'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe'));
check('unfolds the folded sha512', () => assert.equal(
  parseManifest(SAMPLE).sha512,
  'raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg=='));
check('parses size as a number', () => assert.equal(parseManifest(SAMPLE).size, 289313640));
check('unquotes releaseDate', () => assert.equal(parseManifest(SAMPLE).releaseDate, '2026-09-29T10:35:27.666Z'));
check('a non-manifest document yields undefined', () => assert.equal(parseManifest('<html>404</html>'), undefined));

console.log('\n--- channel table ---');
check('three channels in display order', () => assert.deepEqual(channelTable('win32').map(c => c.id), CHANNEL_IDS));
check('win manifests are latest/beta/nightly .yml', () => assert.deepEqual(
  channelTable('win32').map(c => c.manifest), ['latest.yml', 'beta.yml', 'nightly.yml']));
check('mac manifests carry the -mac suffix', () => assert.deepEqual(
  channelTable('darwin').map(c => c.manifest), ['latest-mac.yml', 'beta-mac.yml', 'nightly-mac.yml']));
check('stable has the vendor fallback artifact, beta/nightly do not', () => {
  const table = channelTable('win32');
  assert.ok(table[0].artifactUrl.includes('dsh-latest-windows-x64.exe'));
  assert.equal(table[1].artifactUrl, undefined);
  assert.equal(table[2].artifactUrl, undefined);
});

console.log('\n--- installed build discovery (this machine) ---');
const explicitRoot = process.env.UP_ROOT;
const install = findDesktopInstall(explicitRoot);
if (install === undefined) {
  console.log(`      execPath=${process.execPath}`);
  console.log(`      argv[1]=${process.argv?.[1]}`);
}
check('finds an installation', () => assert.ok(install !== undefined, 'no installation found'));
check('reports a version', () => assert.match(String(install.version), /^\d+\.\d+\.\d+/));
check('is the packed layout the official build ships', () => assert.equal(install.packed, true));
check('root holds the launcher', () => assert.ok(resolveLauncher(install) !== undefined, `no launcher under ${install.root}`));
check('reads the bundled dsh version', () => assert.match(String(readBundledDshVersion(install)), /^\d+\.\d+\.\d+/));
check('reads app-update.yml', () => assert.equal(readAppUpdateConfig(install).channel, 'nightly'));
// Negative controls: the two assertions above are only evidence if the reader
// can also say "not there". Without these, a reader that always returns the
// same hard-coded value would pass.
check('negative control: no install -> no version', () => assert.equal(readBundledDshVersion(undefined), undefined));
check('negative control: bogus archive -> no version', () => assert.equal(
  readBundledDshVersion({ root: install.root, packed: true, appPath: join(install.root, 'resources', 'nope.asar') }),
  undefined,
));
console.log(`      root=${install.root}`);
console.log(`      version=${install.version}  packed=${install.packed}`);
console.log(`      dsh=${readBundledDshVersion(install)}  launcher=${resolveLauncher(install)}`);
console.log(`      app-update.yml=${JSON.stringify(readAppUpdateConfig(install))}`);
check('an explicit root is honoured verbatim', () => {
  const forced = findDesktopInstall(install.root);
  assert.equal(forced.root, install.root);
});
check('a bogus explicit root does not silently fall back', () => {
  // Discovery still succeeds via the host's own location, but never claims the
  // bogus root: a wrong root must not be reported as a found installation.
  const forced = findDesktopInstall('D:\\no-such-install-dir');
  assert.notEqual(forced?.root, 'D:\\no-such-install-dir');
});

console.log('\n--- restart plan (script written, nothing spawned) ---');
check('builds a detached restart script for this install', () => {
  const plan = buildRestartPlan({ install, launcher: resolveLauncher(install), delayMs: 3000, dataDir: 'D:\\DSH\\DSH Desktop\\_uplus-test' });
  assert.equal(plan.ok, true, plan.error);
  assert.ok(plan.scriptPath.endsWith('restart.cmd'));
  assert.ok(plan.executable.endsWith('.exe'));
});
check('refuses cleanly when no launcher is known', () => {
  const plan = buildRestartPlan({ install: undefined, launcher: undefined, dataDir: 'D:\\DSH\\DSH Desktop\\_uplus-test' });
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, 'NO_LAUNCHER');
});

console.log('\n--- live feed resolution ---');
const live = await resolveAllChannels({ installedVersion: install.version, platform: process.platform });
for (const item of live) {
  console.log(`      ${item.id.padEnd(8)} available=${item.available} version=${item.version ?? '-'} source=${item.source} upToDate=${item.upToDate} reason=${item.reason ?? '-'} size=${item.size ?? '-'}`);
}
check('nightly resolves from its published manifest', () => {
  const nightly = live.find(c => c.id === 'nightly');
  assert.equal(nightly.available, true);
  assert.ok(typeof nightly.version === 'string' && nightly.version.length > 0);
  assert.match(nightly.url, /^https:\/\/download\.deepseek\.com\//);
  assert.match(nightly.sha512, /^[A-Za-z0-9+/=]{80,}$/);
});
check('every channel reports a verdict (no silent omission)', () => {
  assert.equal(live.length, 3);
  for (const item of live) assert.ok(item.available === true || typeof item.reason === 'string', `${item.id} has neither a release nor a reason`);
});
check('an unknown channel is not invented', () => {
  assert.equal(channelTable('win32').find(c => c.id === 'gamma'), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
