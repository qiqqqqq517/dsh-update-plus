/**
 * Load the plugin the way the DESKTOP HOST does: real cordis, real service
 * injection, real config resolution.
 *
 * This exists because the running host caches an ESM module for the process
 * lifetime: the first install had a plain-object `Config` export, cordis threw
 * inside `resolveConfig`, and re-enabling the entry in that same process kept
 * resolving against the cached module. Testing against the host's own cordis
 * proves the current source loads, without restarting the user's app.
 *
 * Run: node test-cordis-load.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Windows requires a file:// URL for a dynamic import; a bare `D:/…` path is
// rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const CORDIS = pathToFileURL('D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js').href;
const cordis = await import(CORDIS);
console.log('cordis exports:', Object.keys(cordis).slice(0, 12).join(', '));

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`); }
  catch (error) { fail++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default;
assert.equal(typeof Context, 'function', 'cordis did not export a Context constructor');

const mod = await import('./lib/index.js');

await check('the module exports no Config, so cordis resolves config verbatim', () => {
  assert.equal(mod.Config, undefined);
});

await check('ctx.plugin(module) activates against real cordis', async () => {
  const app = new Context();
  const registered = [];
  // The only service the plugin touches. `provide` is cordis's own supply path,
  // so `ctx.inject(['webServer'])` resolves exactly as it does in the host.
  app.provide('webServer', {
    register(route, label) {
      registered.push({ route, label });
      return () => {};
    },
  });
  const fiber = app.plugin(mod, { restartDelayMs: 4000 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(registered.length, 1, `registered ${registered.length} routes; fiber state unavailable`);
  assert.equal(registered[0].route.path, '/dsh-update-plus/api');
  app.stop?.();
});

await check('an empty config object (what the patch row passes) is accepted', async () => {
  const app = new Context();
  const registered = [];
  app.provide('webServer', { register(route) { registered.push(route); return () => {}; } });
  app.plugin(mod, {});
  // Fiber activation is deferred: asserting synchronously observes zero routes
  // even on a healthy plugin.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(registered.length, 1);
  app.stop?.();
});

await check('a bogus config value does not break activation', async () => {
  const app = new Context();
  const registered = [];
  app.provide('webServer', { register(route) { registered.push(route); return () => {}; } });
  app.plugin(mod, { restartDelayMs: 'not a number', channel: 42 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(registered.length, 1);
  app.stop?.();
});

// Negative control: the ORIGINAL defect must still be detectable, otherwise the
// tests above would pass for a plugin that never loaded at all. A `Config`
// export that is not a standard schema makes cordis refuse the plugin, so
// `apply` must never run.
await check('negative control: a plain-object Config export makes cordis refuse the plugin', async () => {
  const app = new Context();
  let ran = false;
  app.provide('webServer', { register() { return () => {}; } });
  try {
    app.plugin({ name: 'negative-control', Config: { installRoot: '' }, apply() { ran = true; } }, {});
  } catch {
    // Refusing synchronously is also a refusal.
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(ran, false, 'cordis ran apply() for a non-schema Config — this control has no discriminating power');
  app.stop?.();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
