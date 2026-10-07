/**
 * Load the plugin the way the loader does, against a stub context, so a startup
 * failure is visible as an error instead of an opaque `fiberPhase: failed`.
 *
 * Run: node test-load.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
console.log('package name =', pkg.name);
console.log('main         =', pkg.main);
console.log('exports "."  =', pkg.exports['.']);
console.log('exports ./client =', pkg.exports['./client']);
console.log('dsh.client   =', JSON.stringify(pkg.dsh.client));

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`); }
  catch (error) { fail++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

/** The smallest context that observes what apply() actually touches. */
function stubContext() {
  const registered = [];
  const effects = [];
  const injected = [];
  const ctx = {
    inject(names, callback) {
      injected.push(names);
      // Same context, not a fresh one: `ctx.inject` hands the SAME owner scope
      // to the callback, so `host.webServer` must be the very object the test
      // inspects. Building a second stub here made the route assertion fail
      // against an empty array while the plugin was working correctly.
      callback(ctx);
      return () => {};
    },
    effect(callback) {
      // `ctx.effect` RUNS the callback immediately and keeps its returned
      // disposer. A stub that only records it would observe an empty route
      // table while the plugin registers correctly on a real context.
      effects.push(callback);
      callback();
      return () => {};
    },
    get() { return undefined; },
    on() { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route, label) {
        registered.push({ route, label });
        return () => {};
      },
    },
  };
  return { registered, effects, injected, ctx };
}

const mod = await import('./lib/index.js');

await check('exports a name', () => assert.equal(typeof mod.name, 'string'));
await check('exports an apply function', () => assert.equal(typeof mod.apply, 'function'));
await check('does not export a Config that the loader will try to parse as a schema', () => {
  // The dsh loader treats a `Config` export as a SCHEMA (`z.object(...)` from
  // @deepseek-ai/schemastery). A plain object throws inside the loader and the
  // plugin surfaces only as `fiberPhase: failed`.
  const value = mod.Config;
  if (value === undefined) return;
  const looksLikeSchema = typeof value?.parse === 'function' || typeof value?.['~standard'] === 'object';
  assert.ok(looksLikeSchema, `Config is exported but is not a schema (got ${typeof value})`);
});

await check('apply() registers exactly one web route', () => {
  const stub = stubContext();
  mod.apply(stub.ctx, {});
  assert.equal(stub.registered.length, 1, `registered ${stub.registered.length} routes`);
  assert.equal(stub.registered[0].route.path, '/dsh-update-plus/api');
  assert.equal(typeof stub.registered[0].route.handler, 'function');
});

await check('the route answers GET ?action=state with a JSON document', async () => {
  const stub = stubContext();
  mod.apply(stub.ctx, {});
  const handler = stub.registered[0].route.handler;
  const response = {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await handler({ url: '/dsh-update-plus/api?action=state', method: 'GET', headers: {}, on() {}, }, response);
  assert.equal(response.statusCode, 200, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.install.found, true, 'the API did not find the installation');
  assert.equal(payload.install.appVersion, '0.2.0-rc.2');
  assert.equal(payload.channels.length, 3);
  console.log(`      install.root=${payload.install.root}`);
  console.log(`      channels=${payload.channels.map(c => `${c.id}:${c.manifest}`).join(', ')}`);
});

await check('a cross-origin write is refused', async () => {
  const stub = stubContext();
  mod.apply(stub.ctx, {});
  const handler = stub.registered[0].route.handler;
  const response = { writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  await handler({
    url: '/dsh-update-plus/api?action=restart',
    method: 'POST',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' },
    on(event, cb) { if (event === 'end') cb(); },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /cross-origin/);
});

await check('an unknown action is a 404, not a crash', async () => {
  const stub = stubContext();
  mod.apply(stub.ctx, {});
  const handler = stub.registered[0].route.handler;
  const response = { writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  await handler({ url: '/dsh-update-plus/api?action=nope', method: 'GET', headers: {}, on() {} }, response);
  assert.equal(response.statusCode, 404);
});

// The client half is a __ModuleLoader__ bundle, so it cannot be imported; it is
// parsed instead, which is what the shell's module loader effectively does.
console.log('\n--- client bundle ---');
const client = readFileSync(join(import.meta.dirname, 'lib', 'client.js'), 'utf8');
await check('client.js registers through __ModuleLoader__', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(\{ id: "dsh-update-plus", factory: \(require\) => \{/);
});
await check('client.js registers into the settings.section slot', () => {
  assert.match(client, /ctx\.slots\.register\(\{\s*\n\s*name: "settings\.section"/);
});
await check('client.js targets the host route', () => assert.ok(client.includes('"/dsh-update-plus/api"')));
await check('client.js is syntactically valid JavaScript', () => {
  // Strip the loader wrapper: the factory body is the part that must parse.
  const body = client.slice(client.indexOf('factory: (require) => {') + 'factory: (require) => {'.length, client.lastIndexOf('}})'));
  new Function('require', 'window', body);
});
await check('the restart control is emitted after the update controls', () => {
  // Requirement: the restart button sits BELOW "check for updates".
  const actionsAt = client.indexOf('key: "actions"');
  const restartAt = client.indexOf('key: "restart"');
  assert.ok(actionsAt > 0 && restartAt > 0);
  assert.ok(restartAt > actionsAt, `restart at ${restartAt} is not after the update controls at ${actionsAt}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
