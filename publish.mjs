/**
 * Safe publish for dsh-update-plus.
 *
 * WHY NOT A BARE `npm publish`
 * This machine's npm registry is a READ-ONLY MIRROR (`registry.npmmirror.com`,
 * set in ~/.npmrc). Publishing there cannot work, and a bare `npm publish`
 * configured that way either fails cryptically or succeeds against a registry
 * the author did not intend. This script therefore requires the target registry
 * to be stated explicitly, refuses known mirrors, proves the identity on that
 * registry, checks exactly which files would ship, and only then publishes.
 *
 * USAGE
 *   node publish.mjs --check                                   # file-list audit only, no network
 *   node publish.mjs --registry https://registry.npmjs.org      # audit, then publish
 *   node publish.mjs --registry <url> --dry-run                 # audit + `npm publish --dry-run`
 *   node publish.mjs --registry <url> --otp 123456              # with a 2FA one-time code
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

/**
 * Run npm.
 *
 * `execFileSync('npm', ...)` fails on Windows with `spawnSync npm ENOENT`: npm
 * is a `.cmd` batch shim, not an executable, and Node cannot spawn it without a
 * shell. Going through the real CLI entry point beside this node binary avoids
 * `shell: true` entirely, which matters here because the registry URL comes
 * from the command line and must never reach a shell.
 */
const NPM_CLI = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
].find(path => existsSync(path));

function npm(args, options = {}) {
  if (NPM_CLI !== undefined) return execFileSync(process.execPath, [NPM_CLI, ...args], options);
  // Last resort: the shim, only when npm is not beside this node.
  const shim = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(shim, args, { ...options, shell: process.platform === 'win32' });
}

const argv = process.argv.slice(2);
const readFlag = name => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : (argv[index + 1] ?? true);
};
const has = name => argv.includes(name);
const registry = readFlag('--registry');
const otp = readFlag('--otp');
const checkOnly = has('--check');
const dryRun = has('--dry-run');

/**
 * Registries that only serve reads. Publishing to one of these is never right,
 * and the failure mode is confusing enough that it is refused up front.
 */
const READ_ONLY_MIRRORS = [
  'registry.npmmirror.com',
  'registry.cnpmjs.org',
  'r.cnpmjs.org',
  'mirrors.cloud.tencent.com',
  'mirrors.huaweicloud.com',
  'mirrors.aliyun.com',
];

/** Every file the tarball is allowed to contain. Anything else is a leak. */
const EXPECTED = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'install.mjs',
  'lib/client.js',
  'lib/core.js',
  'lib/index.js',
  'package.json',
];

let failures = 0;
const fail = message => { failures++; console.error(`FAIL  ${message}`); };
const ok = message => console.log(`PASS  ${message}`);

// ---------------------------------------------------------------------------
// 1. Manifest sanity
// ---------------------------------------------------------------------------
console.log(`package      : ${manifest.name}@${manifest.version}`);
console.log(`license      : ${manifest.license}`);
console.log(`publishConfig: ${JSON.stringify(manifest.publishConfig ?? {})}`);
console.log(`npm cli      : ${NPM_CLI ?? '(not found beside this node; will try the shim)'}`);
console.log('');

if (manifest.private === true) fail('the manifest is marked private; npm will refuse to publish it');
else ok('not private');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) fail(`implausible version: ${manifest.version}`);
else ok(`version ${manifest.version} is a valid semver`);

for (const field of ['name', 'version', 'description', 'license', 'main', 'exports', 'dsh']) {
  if (manifest[field] === undefined) fail(`missing required field: ${field}`);
}
ok('required manifest fields are present');

// The host half must NOT export a Config schema object: cordis treats that
// export as a schema, and a plain object makes the plugin fail to activate with
// no usable stack.
const hostSource = readFileSync(join(here, manifest.main), 'utf8');
if (/export\s+const\s+Config\b/u.test(hostSource)) fail('lib/index.js exports Config, which the loader treats as a schema');
else ok('lib/index.js exports no Config (correct)');

if (manifest.exports?.['./client'] === undefined) fail('exports["./client"] is missing, so the settings panel would never load');
else ok('exports["./client"] is present');

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch does not point at ./cordis.patch.yml');
else ok('dsh.bundle.patch points at the shipped patch');

// ---------------------------------------------------------------------------
// 2. File-list audit against the real packer
// ---------------------------------------------------------------------------
console.log('\n--- npm pack --dry-run --json ---');
let packed;
try {
  const out = npm(['pack', '--dry-run', '--json'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(out);
} catch (error) {
  fail(`npm pack failed: ${String(error.stdout ?? error.message).slice(0, 400)}`);
  console.log(`\n${failures} problem(s)`);
  process.exit(1);
}

const files = (packed[0]?.files ?? []).map(entry => entry.path.split('\\').join('/')).sort();
console.log(files.map(path => `  ${path}`).join('\n'));
console.log(`  (${files.length} files, ${packed[0]?.size ?? '?'} packed bytes, ${packed[0]?.unpackedSize ?? '?'} unpacked bytes)\n`);

const missing = EXPECTED.filter(path => !files.includes(path));
if (missing.length > 0) fail(`expected files are MISSING from the tarball: ${missing.join(', ')}`);
else ok('every expected file is in the tarball');

const extra = files.filter(path => !EXPECTED.includes(path));
if (extra.length > 0) fail(`UNEXPECTED files would ship: ${extra.join(', ')}`);
else ok('nothing unexpected would ship');

let leaked = 0;
for (const path of files) {
  if (/^(test-|verify-|probe-)/u.test(path) || path === 'run-tests.mjs' || path === 'publish.mjs') {
    fail(`a development script would ship: ${path}`);
    leaked++;
  }
  if (path.endsWith('.bak') || path.includes('.bak_')) { fail(`a backup file would ship: ${path}`); leaked++; }
  if (path.startsWith('node_modules/')) { fail(`node_modules would ship: ${path}`); leaked++; }
}
if (leaked === 0) ok('no dev scripts, backups or node_modules in the tarball');

// ---------------------------------------------------------------------------
// 3. Registry + identity
// ---------------------------------------------------------------------------
if (checkOnly) {
  console.log(`\n${failures === 0 ? 'package check PASSED' : `${failures} problem(s)`} (no publish performed)`);
  process.exit(failures === 0 ? 0 : 1);
}

if (registry === undefined) {
  console.error('\n--registry is required. Publishing is a public, hard-to-undo action, so the');
  console.error('target registry is never inferred from the ambient npm config.');
  console.error('  node publish.mjs --registry https://registry.npmjs.org');
  console.error('\nnote: this machine\'s configured registry is a read-only mirror and cannot be published to.');
  process.exit(2);
}

const host = (() => { try { return new URL(registry).host.toLowerCase(); } catch { return ''; } })();
if (READ_ONLY_MIRRORS.includes(host)) {
  console.error(`\nrefusing to publish to ${host}: it is a read-only mirror, not a publish target.`);
  console.error('Use https://registry.npmjs.org (or your own registry).');
  process.exit(2);
}
ok(`target registry ${registry} is not a known read-only mirror`);

let whoami;
try {
  whoami = npm(['whoami', '--registry', registry], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (error) {
  console.error(`\nnot authenticated on ${registry}.`);
  console.error(`Run \`npm login --registry ${registry}\` (or set an //<host>/:_authToken in ~/.npmrc),`);
  console.error('then run this script again. Nothing was published.');
  console.error(`\n(${String(error.stderr ?? error.message).trim().split('\n')[0]})`);
  process.exit(2);
}
ok(`authenticated on ${registry} as ${whoami}`);

// npm refuses to overwrite a version, so check first and say so plainly instead
// of letting the publish fail halfway.
try {
  const existing = npm(['view', `${manifest.name}@${manifest.version}`, 'version', '--registry', registry], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (existing !== '') fail(`${manifest.name}@${manifest.version} is ALREADY published on ${registry}: bump the version`);
  else ok(`${manifest.name}@${manifest.version} is not published yet`);
} catch {
  ok(`${manifest.name}@${manifest.version} is not published yet`);
}

if (failures > 0) {
  console.log(`\n${failures} problem(s); nothing was published.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Publish
// ---------------------------------------------------------------------------
const args = ['publish', '--registry', registry, '--access', manifest.publishConfig?.access ?? 'public'];
if (otp !== undefined) args.push('--otp', String(otp));
if (dryRun) args.push('--dry-run');
console.log(`\n$ npm ${args.join(' ')}`);
try {
  // Captured rather than inherited: the failure text is what says WHICH refusal
  // this is, and the two common ones need opposite instructions. Everything the
  // user would have seen is re-emitted below, so nothing is hidden.
  const output = npm(args, { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(output);
} catch (error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  process.stdout.write(String(error.stdout ?? ''));
  process.stderr.write(String(error.stderr ?? ''));
  console.error(`\npublish FAILED (exit ${error.status ?? '?'}). Nothing else was changed.`);

  // MEASURED on this account: authentication succeeds (`whoami` prints the user)
  // and every preflight passes, but the registry still refuses with
  //   E403 … Two-factor authentication or granular access token with bypass 2fa
  //        enabled is required to publish packages.
  // That is a policy refusal, not a credential problem, and it has exactly two
  // fixes — neither of which this script can do on the user's behalf.
  if (/two-factor|2fa|one-time pass|EOTP/iu.test(text)) {
    console.error('\nThis registry requires 2FA for publishing. Pick one:');
    console.error('');
    console.error('  A) publish with a one-time code (fastest, expires in ~30s):');
    console.error(`       node publish.mjs --registry ${registry} --otp 123456`);
    console.error('');
    console.error('  B) use a Granular Access Token with "Bypass 2FA" enabled (durable;');
    console.error('     later publishes then need no code at all):');
    console.error('       https://www.npmjs.com/settings/~/tokens  →  Generate New Token');
    console.error('       →  Granular Access Token  →  Permissions: Read and write');
    console.error('       →  tick "Bypass 2FA"  →  then, with your own hands:');
    console.error(`       npm config set //${new URL(registry).host}/:_authToken <TOKEN>`);
    console.error('');
    console.error('  Do NOT fix this by turning 2FA off on the account.');
  }
  process.exit(typeof error.status === 'number' ? error.status : 1);
}

const published = `${manifest.name}@${manifest.version}`;
console.log(`\n${dryRun ? '[dry-run] would have published' : 'published'} ${published} to ${registry}`);
if (!dryRun) {
  console.log(`verify : npm view ${published} --registry ${registry}`);
  console.log(`install: add "${manifest.name}" to a profile's dsh.profile.bundles, then pnpm install`);
}
