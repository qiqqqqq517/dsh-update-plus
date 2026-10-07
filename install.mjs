/**
 * Install dsh-update-plus into a dsh profile.
 *
 * WHAT IT DOES (idempotent)
 *   1. copies this package into `<profile>/node_modules/dsh-update-plus`
 *      (through a staging directory, so an interrupted copy can never leave a
 *      half-populated package the loader would then fail on);
 *   2. adds `"dsh-update-plus"` to `dsh.profile.bundles` in the profile's
 *      `package.json`, keeping a `.bak_update-plus` backup the first time;
 *   3. removes the raw patch row an earlier build of this script wrote, since a
 *      bundle is the shape the rest of the profile uses.
 *
 * WHY A BUNDLE AND NOT A PATCH ROW
 * MEASURED on this installation: a plugin mounted by a hand-written
 * `- insert:` row in `cordis.patch.yml` comes up `enabled: false` — the plugin
 * manager treats a row it did not install as discovered-but-off, so the user
 * would have to switch it on before the panel appeared. Every other third-party
 * plugin here (`dsh-builtin-browser`, `dsh-free-search`, `dsh-better-sidebar`,
 * `dsh-context`, …) is a `dsh.profile.bundles` entry instead, and those come up
 * enabled. `install.mjs` therefore uses the same shape.
 *
 * WHY NOT `pnpm add`
 * The package is not published, and the profile's pnpm resolves with a strict
 * `minimumReleaseAge` gate. A directory copy plus one bundle entry needs no
 * registry round-trip and is trivially reversible.
 *
 * A later `pnpm install` in the profile can prune an unmanaged directory. When
 * that happens, run this script again — that is the whole recovery procedure.
 *
 * USAGE
 *   node install.mjs [profile-dir]           # default: $DSH_PROFILE_DIR or ~/.dsh/profiles/desktop
 *   node install.mjs --revert [profile-dir]  # remove the copy and the bundle entry
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PKG = 'dsh-update-plus';
const BACKUP_SUFFIX = '.bak_update-plus';

// The raw patch row an earlier version of this script appended. Removed on
// install so a profile does not end up mounting the plugin twice (once as a
// bundle, once as an orphan row pointing at a package that is still present but
// whose row the plugin manager shows as disabled).
const LEGACY_MARKER = '# --- dsh-update-plus (managed) ---';
const LEGACY_END = '# --- end dsh-update-plus ---';

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const here = import.meta.dirname;

const profileArg = args.find(arg => !arg.startsWith('--'));
const profile = resolve(profileArg
  ?? process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop'));

const profileJsonPath = join(profile, 'package.json');
const patchPath = join(profile, 'cordis.patch.yml');
const targetDir = join(profile, 'node_modules', PKG);

if (!existsSync(profileJsonPath)) {
  console.error(`not a dsh profile (no package.json): ${profile}`);
  console.error('Pass the profile directory: node install.mjs <profile-dir>');
  process.exit(1);
}

/** Refuse to write UTF-8 text that has already been mangled. */
function guard(text, label) {
  const replacement = (text.match(/\uFFFD/gu) ?? []).length;
  if (replacement > 0) throw new Error(`refusing to write ${label}: ${replacement} replacement characters`);
  return text;
}

/** Read/write the profile manifest, preserving its 2-space formatting and EOL. */
function readProfileJson() {
  const raw = readFileSync(profileJsonPath, 'utf8');
  return { raw, json: JSON.parse(guard(raw, 'package.json')) };
}

function writeProfileJson(json, eol) {
  writeFileSync(profileJsonPath, JSON.stringify(json, null, 2).split('\n').join(eol), 'utf8');
}

const { raw: manifestRaw, json: manifest } = readProfileJson();
const eol = manifestRaw.includes('\r\n') ? '\r\n' : '\n';
const bundles = manifest?.dsh?.profile?.bundles;

if (revert) {
  let changed = false;

  if (Array.isArray(bundles) && bundles.includes(PKG)) {
    manifest.dsh.profile.bundles = bundles.filter(name => name !== PKG);
    const backup = `${profileJsonPath}${BACKUP_SUFFIX}`;
    if (existsSync(backup)) {
      writeProfileJson(manifest, eol);
      console.log(`removed "${PKG}" from dsh.profile.bundles`);
    } else {
      writeProfileJson(manifest, eol);
      console.log(`removed "${PKG}" from dsh.profile.bundles (no backup existed, wrote the edited manifest)`);
    }
    changed = true;
  }

  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8');
    if (patch.includes(LEGACY_MARKER)) {
      const start = patch.indexOf(LEGACY_MARKER);
      const end = patch.indexOf(LEGACY_END);
      if (end === -1) {
        console.error('the legacy managed block is damaged (no end marker); fix it by hand.');
        process.exit(1);
      }
      const stripped = `${patch.slice(0, start).replace(/\s+$/u, '')}\n${patch.slice(end + LEGACY_END.length).replace(/^\s+/u, '')}`;
      writeFileSync(patchPath, guard(stripped, 'cordis.patch.yml'), 'utf8');
      console.log(`removed the legacy patch row from ${patchPath}`);
      changed = true;
    }
  }

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`removed ${targetDir}`);
    changed = true;
  }
  console.log(changed ? 'reverted. Restart DSH Desktop to unload it.' : 'nothing to revert.');
  process.exit(0);
}

// 1. Bundle entry.
if (Array.isArray(bundles) && bundles.includes(PKG)) {
  console.log(`"${PKG}" is already a profile bundle`);
} else if (manifest?.dsh?.profile === undefined) {
  console.error('this profile has no dsh.profile section; mount the plugin by hand.');
  process.exit(1);
} else {
  const backup = `${profileJsonPath}${BACKUP_SUFFIX}`;
  if (!existsSync(backup)) {
    writeFileSync(backup, manifestRaw, 'utf8');
    console.log(`backed up package.json -> ${backup}`);
  }
  manifest.dsh.profile.bundles = [...(Array.isArray(bundles) ? bundles : []), PKG];
  writeProfileJson(manifest, eol);
  console.log(`added "${PKG}" to dsh.profile.bundles`);
}

// 2. Drop the legacy raw row, so the plugin is mounted once.
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8');
  if (patch.includes(LEGACY_MARKER)) {
    const start = patch.indexOf(LEGACY_MARKER);
    const end = patch.indexOf(LEGACY_END);
    if (end !== -1) {
      const stripped = `${patch.slice(0, start).replace(/\s+$/u, '')}\n${patch.slice(end + LEGACY_END.length).replace(/^\s+/u, '')}`;
      writeFileSync(patchPath, guard(stripped, 'cordis.patch.yml'), 'utf8');
      console.log('removed the legacy raw patch row (the bundle entry replaces it)');
    }
  }
}

// 3. Package copy.
mkdirSync(dirname(targetDir), { recursive: true });
const staging = `${targetDir}.staging`;
rmSync(staging, { recursive: true, force: true });
cpSync(here, staging, {
  recursive: true,
  filter: source => {
    const name = source.slice(here.length + 1);
    if (name === '') return true;
    if (name.startsWith('node_modules') || name === '.git') return false;
    // Tests and one-off verification scripts are not part of the runtime.
    return !/^(test-|verify-|probe-).*\.mjs$/u.test(name) && name !== 'run-tests.mjs';
  },
});
rmSync(targetDir, { recursive: true, force: true });
renameSync(staging, targetDir);
console.log(`installed ${targetDir}`);

let missing = 0;
for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/core.js']) {
  const path = join(targetDir, file);
  if (!existsSync(path)) { console.error(`MISSING after install: ${path}`); missing++; }
}
if (missing > 0) process.exit(1);
console.log('all expected files are in place.');
console.log('Restart DSH Desktop to load it, then open Settings → 更新与重启.');
