/**
 * Run every suite for dsh-update-plus.
 *
 * The host runtime is the Electron binary re-entered as Node, which is the only
 * runtime where Electron's asar layer is active — and the asar-dependent checks
 * (reading the installed build) only mean something there. `spawnSync` is used
 * rather than a shell call because PowerShell does not wait for that binary.
 *
 * Run: node run-tests.mjs
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HOST = 'D:\\DSH\\DeepSeek Harness.exe';
const useHost = process.platform === 'win32' && existsSync(HOST);
const binary = useHost ? HOST : process.execPath;
const env = useHost ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env };
delete env.ELECTRON_NO_ASAR;

const suites = [
  ['core (versions, manifests, install discovery, live feeds)', 'test-core.mjs'],
  ['download pipeline (streaming, digest, cancel, controls)', 'test-download.mjs'],
  ['host half (route, actions, origin guard)', 'test-load.mjs'],
  ['host half under real cordis (activation, config)', 'test-cordis-load.mjs'],
  ['client half (ModuleLoader, slot, dictionaries)', 'test-client.mjs'],
  ['installed copy in the profile (resolution, patch, drift)', 'test-install.mjs'],
  ['release artifact (npm pack, extract, load the tarball)', 'verify-tarball.mjs'],
];

console.log(`runtime: ${useHost ? `host (${binary})` : `plain node (${binary})`}`);
console.log(`asar layer: ${useHost ? 'active' : 'inactive — host-runtime checks will SKIP'}\n`);

let failed = 0;
for (const [label, file] of suites) {
  console.log(`\n${'='.repeat(78)}\n${label}\n  ${file}\n${'='.repeat(78)}`);
  const result = spawnSync(binary, [file], { stdio: 'inherit', env, cwd: import.meta.dirname });
  if (result.status !== 0) {
    failed++;
    console.log(`>>> ${file} FAILED (exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''})`);
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
