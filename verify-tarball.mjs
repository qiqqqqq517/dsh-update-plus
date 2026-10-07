/**
 * Verify the ACTUAL npm tarball, not the source tree.
 *
 * The packer's file list says what would ship; this says the shipped bytes work:
 * it packs, extracts, then loads the host half under real cordis and executes
 * the client bundle out of the extracted tree. A test that only ever imports the
 * source directory cannot catch a file that the `files` allow-list dropped, or a
 * path that only resolves because the development tree still has it.
 *
 * Run: node verify-tarball.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'dsh-update-plus-tarball-'));

const PATH_DIRS = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);

/**
 * Find npm's real CLI and a plain Node to run it with.
 *
 * `process.execPath` is NOT usable for this: this suite runs under the host
 * runtime (the Electron binary re-entered as Node), where npm is not installed
 * beside the executable. npm also is not spawnable as `npm` on Windows (it is a
 * `.cmd` shim), so the CLI entry point is located explicitly.
 */
function findNpmCli() {
  const candidates = [];
  if (typeof process.env.npm_execpath === 'string' && process.env.npm_execpath !== '') candidates.push(process.env.npm_execpath);
  for (const dir of [dirname(process.execPath), ...PATH_DIRS]) {
    candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  candidates.push('/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
  return candidates.find(path => existsSync(path));
}

function findPlainNode() {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of PATH_DIRS) {
    for (const name of names) {
      const candidate = join(dir, name);
      // Skip the Electron binary even if it is on PATH under a node-ish name.
      if (existsSync(candidate) && !/DeepSeek Harness/iu.test(candidate)) return candidate;
    }
  }
  return process.execPath;
}

const NPM_CLI = findNpmCli();
const NODE_FOR_NPM = findPlainNode();

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`); }
  catch (error) { fail++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

try {
  // ---- pack -------------------------------------------------------------
  console.log(`work        : ${work}`);
  console.log(`plain node  : ${NODE_FOR_NPM}`);
  console.log(`npm cli     : ${NPM_CLI}\n`);
  await check('a usable npm CLI and node were located', () => {
    assert.ok(NPM_CLI, 'npm-cli.js not found');
    assert.ok(NODE_FOR_NPM, 'no node found');
  });
  execFileSync(NODE_FOR_NPM, [NPM_CLI, 'pack', '--pack-destination', work], {
    cwd: here,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  const tgz = readdirSync(work).find(name => name.endsWith('.tgz'));
  await check('npm pack produced a tarball', () => assert.ok(tgz, 'no .tgz in ' + work));
  const tarball = join(work, tgz);

  // ---- extract ----------------------------------------------------------
  const extracted = join(work, 'extracted');
  mkdirSync(extracted, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pkgDir = join(extracted, 'package');

  await check('the tarball extracts to package/', () => assert.ok(existsSync(pkgDir)));

  const shipped = [];
  (function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), next);
      else shipped.push(next);
    }
  })(pkgDir, '');
  shipped.sort();
  console.log('  shipped: ' + shipped.join(', '));

  await check('exactly the allowed files shipped', () => assert.deepEqual(shipped, [
    'LICENSE', 'README.md', 'cordis.patch.yml', 'install.mjs',
    'lib/client.js', 'lib/core.js', 'lib/index.js', 'package.json',
  ]));
  await check('no development script leaked into the tarball', () => {
    for (const path of shipped) {
      assert.ok(!/^(test-|verify-|probe-)/u.test(path), `leaked: ${path}`);
      assert.ok(path !== 'run-tests.mjs' && path !== 'publish.mjs', `leaked: ${path}`);
    }
  });
  await check('the shipped manifest is the same package and version', () => {
    const shippedManifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(shippedManifest.name, manifest.name);
    assert.equal(shippedManifest.version, manifest.version);
    assert.equal(shippedManifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(shippedManifest.exports['./client'], './lib/client.js');
  });
  await check('the shipped cordis patch parses and mounts this package', async () => {
    const yamlUrl = pathToFileURL(join(here, '..', '..', 'profiles', 'desktop', 'node_modules', 'yaml', 'dist', 'index.js')).href;
    const YAML = (await import(yamlUrl)).default;
    const document = YAML.parse(readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8'));
    const flat = JSON.stringify(document);
    assert.ok(flat.includes(manifest.name), 'the patch does not name the package');
  });

  // ---- host half under real cordis, from the extracted tree --------------
  const cordis = await import(pathToFileURL('D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js').href);
  const shippedHost = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href);

  await check('the shipped host half exports no Config (no schema trap)', () => assert.equal(shippedHost.Config, undefined));
  await check('the shipped host half activates under real cordis and registers its route', async () => {
    const app = new cordis.Context();
    const routes = [];
    app.provide('webServer', { register(route, label) { routes.push({ route, label }); return () => {}; } });
    app.plugin(shippedHost, {});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(routes.length, 1, `registered ${routes.length} routes`);
    assert.equal(routes[0].route.path, '/dsh-update-plus/api');
    app.stop?.();
  });
  await check('the shipped route answers ?action=state with a real installation', async () => {
    const app = new cordis.Context();
    const routes = [];
    app.provide('webServer', { register(route) { routes.push(route); return () => {}; } });
    app.plugin(shippedHost, {});
    await new Promise(resolve => setTimeout(resolve, 300));
    const response = { writeHead(status) { this.statusCode = status; }, end(body) { this.body = body; } };
    await routes[0].handler({ url: '/dsh-update-plus/api?action=state', method: 'GET', headers: {}, on() {} }, response);
    assert.equal(response.statusCode, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.install.found, true);
    assert.equal(payload.install.appVersion, '0.2.0-rc.2');
    app.stop?.();
  });

  // ---- client half from the extracted tree -------------------------------
  await check('the shipped client bundle registers into settings.section', () => {
    let captured;
    const windowStub = { __ModuleLoader__: { load: definition => { captured = definition; } } };
    // eslint-disable-next-line no-new-func
    new Function('window', readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8'))(windowStub);
    assert.equal(captured.id, manifest.name);

    const reactStub = {
      createElement: () => null, useState: v => [v, () => {}],
      useEffect: () => {}, useCallback: fn => fn, useRef: () => ({ current: null }),
    };
    const exported = captured.factory(name => {
      if (name === 'react') return reactStub;
      throw new Error(`unexpected require: ${name}`);
    });
    const slots = [];
    exported.apply({
      effect: callback => callback(),
      locale: { register: () => {}, bind: () => key => key },
      slots: { inject: (name, callback) => callback(), register: (definition, component) => { slots.push({ definition, component }); } },
    });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].definition.name, 'settings.section');
  });
  await check('the shipped core resolves the live channel table', async () => {
    const core = await import(pathToFileURL(join(pkgDir, 'lib', 'core.js')).href);
    assert.deepEqual(core.channelTable('win32').map(c => c.id), ['stable', 'beta', 'nightly']);
  });
} finally {
  // Leave nothing behind: the tarball, the extraction and any stray copy.
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
