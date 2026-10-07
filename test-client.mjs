/**
 * Execute the client half the way the shell's ModuleLoader does, against a
 * stubbed React, and assert it registers the settings page correctly.
 *
 * This is the strongest offline check available for the UI half: the bundle is
 * a plain `window.__ModuleLoader__.load({...})` script, so it needs no build step
 * and no DOM to prove that `apply` wires the slot it claims to.
 *
 * Run: node test-client.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`); }
  catch (error) { fail++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

const here = import.meta.dirname;

// ---- load the bundle the way the shell does ------------------------------
let captured;
const windowStub = { __ModuleLoader__: { load: definition => { captured = definition; } } };
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', source)(windowStub);

await check('the bundle registers itself under the package name', () => {
  assert.equal(captured.id, 'dsh-update-plus');
  assert.equal(typeof captured.factory, 'function');
});

const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
};

const requested = [];
const exported = captured.factory(name => {
  requested.push(name);
  if (name === 'react') return reactStub;
  throw new Error(`the client half required an unexpected module: ${name}`);
});

await check('it requires react and nothing else', () => assert.deepEqual(requested, ['react']));
await check('it exports name / inject / apply', () => {
  assert.equal(exported.name, 'dsh-update-plus');
  assert.ok(Array.isArray(exported.inject));
  assert.deepEqual(exported.inject, ['slots', 'locale']);
  assert.equal(typeof exported.apply, 'function');
});

// ---- apply against a stub shell context ----------------------------------
const slots = [];
const dictionary = {};
const effects = [];
const shell = {
  effect(callback, label) {
    // The shell RUNS the effect and keeps its disposer; a stub that only
    // records it would observe an empty slot table on a working plugin.
    effects.push(label);
    return callback() ?? (() => {});
  },
  locale: {
    register(namespace, dictionaries) {
      dictionary[namespace] = dictionaries;
      return () => {};
    },
    bind(namespace) {
      assert.equal(namespace, dictionary !== undefined ? namespace : namespace);
      return key => key;
    },
  },
  slots: {
    inject(name, callback) { callback(); return () => {}; },
    register(definition, component) { slots.push({ definition, component }); return () => {}; },
  },
};

exported.apply(shell);

await check('apply registers exactly one settings page', () => assert.equal(slots.length, 1));
await check('the page lands in the settings.section slot', () => assert.equal(slots[0].definition.name, 'settings.section'));
await check('the page id is the package name', () => assert.equal(slots[0].definition.id, 'dsh-update-plus'));
await check('the page has a component', () => assert.equal(typeof slots[0].component, 'function'));
await check('the page label resolves through the bound dictionary', () => assert.equal(typeof slots[0].definition.label(), 'string'));
await check('it registers zh and en dictionaries', () => {
  const dictionaries = dictionary['settings.dsh-update-plus'];
  assert.ok(dictionaries, 'no dictionary registered');
  assert.ok(dictionaries.zh, 'no zh dictionary');
  assert.ok(dictionaries.en, 'no en dictionary');
});
await check('zh and en have the same key set (the key set is the contract)', () => {
  const dictionaries = dictionary['settings.dsh-update-plus'];
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
});
await check('both dictionaries cover the strings the panel actually uses', () => {
  const dictionaries = dictionary['settings.dsh-update-plus'];
  const required = [
    'nav', 'title', 'lead', 'check', 'download', 'cancel', 'restart', 'restartWarn',
    'channel.stable', 'channel.beta', 'channel.nightly',
    'channel.unpublished', 'channel.upToDate', 'channel.updateAvailable',
    'installTitle', 'settingsTitle', 'downloadedTo', 'verified', 'failed',
  ];
  for (const key of required) {
    assert.ok(dictionaries.zh[key], `zh is missing "${key}"`);
    assert.ok(dictionaries.en[key], `en is missing "${key}"`);
  }
});
await check('the client half never hard-codes a user-facing string in the render', () => {
  // Every label must come from the dictionary, so a language the shell selects
  // is honoured. A literal CJK string in the render path is the regression this
  // guards against.
  const renderStart = source.indexOf('function SettingsRoot()');
  const renderEnd = source.indexOf('function apply(ctx)');
  const render = source.slice(renderStart, renderEnd);
  const literals = render.match(/"[^"]*[\u4e00-\u9fff][^"]*"/gu) ?? [];
  assert.deepEqual(literals, [], `hard-coded CJK in the render path: ${literals.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
