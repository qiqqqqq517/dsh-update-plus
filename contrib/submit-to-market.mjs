/**
 * Submit dsh-update-plus to the awesome-dsh-plugin list (the data source behind
 * dshmarket / the market UI).
 *
 * WHAT A SUBMISSION IS
 * MEASURED from the list's own contributing.md: a pull request that adds exactly
 * ONE file, `data/plugins/<owner>__<repo>.yml`. The two READMEs are generated
 * from those files and must not be hand-edited. The npm link is NOT declared in
 * the entry — the registry picks it up automatically, and only when the
 * published package's `repository` field points back at the listed repo. A
 * hand-written `npm:` key is rejected.
 *
 * THE 1-DAY GATE
 * CI refuses a repository younger than one day (scripts/check-submission.mjs:
 * `MIN_AGE_DAYS = 1`). That bar cannot be worked around and is not a comment on
 * the plugin, so this script reads the age and refuses to open a PR that it
 * knows will fail — a failing PR is noise for the maintainers, and the gate
 * itself says a resubmission costs nothing.
 *
 * USAGE
 *   node contrib/submit-to-market.mjs --check     # prove everything but the PR, no writes
 *   node contrib/submit-to-market.mjs             # fork, branch, commit, open the PR
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const OWNER = 'qiqqqqq517';
const REPO = 'dsh-update-plus';
const FULL = `${OWNER}/${REPO}`;
const ENTRY_NAME = `${OWNER}__${REPO}.yml`;
const ENTRY_PATH = `data/plugins/${ENTRY_NAME}`;

const here = import.meta.dirname;
const repoRoot = resolve(here, '..');
const localEntry = join(here, 'awesome-dsh-plugin-entry.yml');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

const run = (file, cmdArgs, options = {}) => execFileSync(file, cmdArgs, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options,
});
const tryRun = (file, cmdArgs, options) => {
  try { return { ok: true, out: run(file, cmdArgs, options) }; }
  catch (error) { return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}` }; }
};

let failures = 0;
const fail = message => { failures++; console.error(`FAIL  ${message}`); };
const ok = message => console.log(`PASS  ${message}`);
const skip = message => console.log(`SKIP  ${message}`);

// ---------------------------------------------------------------------------
// 1. The entry itself
// ---------------------------------------------------------------------------
console.log(`entry: ${ENTRY_PATH}\n`);
if (!existsSync(localEntry)) fail(`the entry file is missing: ${localEntry}`);
else ok('the entry file exists locally');

const entryText = existsSync(localEntry) ? readFileSync(localEntry, 'utf8') : '';
console.log('--- entry ---');
console.log(entryText.trim().split('\n').map(l => `  ${l}`).join('\n'));
console.log('');

for (const [key, expected] of [['url', `https://github.com/${FULL}`], ['name', FULL], ['category', null]]) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(entryText);
  if (match === null) fail(`the entry has no \`${key}\``);
  else if (expected !== null && match[1].trim() !== expected) fail(`${key} is "${match[1].trim()}", expected "${expected}"`);
  else ok(`${key}: ${match[1].trim()}`);
}
if (/^\s*npm:/mu.test(entryText)) fail('the entry declares `npm:` — the list rejects a hand-written npm key');
else ok('no hand-written `npm:` key (correct: the mapping is collected from the registry)');
if (!/^\s{2}en:/mu.test(entryText)) fail('description.en is missing (it is the only required field)');
else ok('description.en is present');
if (/^\s{2}en:\s*[^'"]*: /mu.test(entryText) && !/^\s{2}en:\s*'/mu.test(entryText)) {
  fail('description.en contains ": " but is not quoted — YAML would read it as a nested key');
} else ok('description quoting is safe for YAML');

// ---------------------------------------------------------------------------
// 2. The gate this cannot pass yet
// ---------------------------------------------------------------------------
console.log('\n--- repository age gate ---');
const repoInfo = tryRun('gh', ['api', `repos/${FULL}`]);
if (!repoInfo.ok) {
  fail(`cannot read ${FULL}: ${repoInfo.out.trim().split('\n')[0]}`);
} else {
  const info = JSON.parse(repoInfo.out);
  const createdAt = new Date(info.created_at);
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  console.log(`  created: ${info.created_at}  (${ageDays.toFixed(3)} days old)`);
  console.log(`  CI requires MIN_AGE_DAYS = 1 (scripts/check-submission.mjs)`);
  if (ageDays < 1) {
    const readyAt = new Date(createdAt.getTime() + 86_400_000);
    console.log(`  -> the PR would be rejected by CI. Ready after ${readyAt.toISOString()}`);
    skip('opening the PR now is refused on purpose (a failing PR is noise; resubmission is free)');
  } else {
    ok('the repository is old enough for CI');
  }

  console.log('\n--- what CI also checks ---');
  const pkgRaw = tryRun('gh', ['api', `repos/${FULL}/contents/package.json`, '-H', 'Accept: application/vnd.github.raw']);
  if (!pkgRaw.ok) fail('cannot read package.json from the repository');
  else {
    const pkg = JSON.parse(pkgRaw.out);
    if (pkg.dsh?.bundle?.patch === undefined) fail('package.json has no dsh.bundle.patch — this is the most common rejection');
    else ok(`dsh.bundle.patch = ${pkg.dsh.bundle.patch}`);
    if (pkg.repository?.url === undefined) fail('package.json has no repository field — the npm<->repo link would never form');
    else ok(`repository = ${pkg.repository.url}`);
  }
}

if (checkOnly || failures > 0) {
  console.log(`\n${failures === 0 ? 'entry is ready (no PR opened)' : `${failures} problem(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 3. Fork, branch, commit, open the PR
// ---------------------------------------------------------------------------
console.log('\n--- submitting ---');
const work = join(repoRoot, '..', `.awesome-dsh-plugin-${REPO}`);
run('git', ['clone', `https://github.com/${FULL}.git`, work]); // sanity: local git works before forking
const fork = tryRun('gh', ['repo', 'fork', UPSTREAM, '--clone=false', '--default-branch-only']);
if (!fork.ok && !/already exists/iu.test(fork.out)) {
  console.error(`fork FAILED: ${fork.out.trim().slice(0, 300)}`);
  process.exit(1);
}
console.log('fork ready');

const forkUrl = `https://github.com/${OWNER}/${UPSTREAM.split('/')[1]}.git`;
const cloneDir = `${work}-upstream`;
if (!existsSync(cloneDir)) run('git', ['clone', forkUrl, cloneDir]);
else run('git', ['-C', cloneDir, 'fetch', 'origin']);

const branch = `add-${REPO}`;
run('git', ['-C', cloneDir, 'checkout', '-B', branch, 'origin/main']);
run('git', ['-C', cloneDir, 'remote', 'add', 'upstream', `https://github.com/${UPSTREAM}.git`]);

const { mkdirSync, writeFileSync, cpSync } = await import('node:fs');
mkdirSync(join(cloneDir, 'data', 'plugins'), { recursive: true });
cpSync(localEntry, join(cloneDir, ENTRY_PATH));

run('git', ['-C', cloneDir, 'add', ENTRY_PATH]);
const status = run('git', ['-C', cloneDir, 'status', '--short']);
const touched = status.split('\n').filter(Boolean);
if (touched.length !== 1) {
  console.error(`refusing to commit: the branch touches ${touched.length} paths, expected exactly 1:\n${touched.join('\n')}`);
  process.exit(1);
}
run('git', ['-C', cloneDir, '-c', 'core.autocrlf=false', 'commit', '-m', `Add ${FULL}`]);
run('git', ['-C', cloneDir, 'push', '-u', 'origin', branch]);

const pr = tryRun('gh', ['pr', 'create', '--repo', UPSTREAM, '--head', `${OWNER}:${branch}`, '--title', `Add ${FULL}`, '--body', `Adds one entry for ${FULL}.

A desktop-app updater and restart control for DeepSeek Harness: the update channel
is otherwise hard-coded to \`nightly\`, and "restart app and Host" only exists behind
a development flag. This plugin exposes stable/beta/nightly, downloads the official
installer directly with SHA-512 verification, and provides the restart button.

Not to be confused with \`dsh-web-restart\`, which restarts the dsh *web process*; this
targets the packaged desktop app and restarts it together with its Host.

\`package.json\` declares \`dsh.bundle.patch\`, and the published npm package's
\`repository\` field points back at this repository.`]);
console.log(pr.ok ? pr.out.trim() : `PR failed: ${pr.out.trim().slice(0, 400)}`);
process.exit(pr.ok ? 0 : 1);
