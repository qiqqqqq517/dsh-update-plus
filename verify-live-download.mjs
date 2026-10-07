/**
 * One real, full-size download from the vendor feed, with digest verification.
 * Proves the end-to-end chain that the plugin's "直接下载最新版本" button runs.
 *
 * Run: node verify-live-download.mjs [channel]
 */
import { channelTable, resolveChannel, DownloadJob, findDesktopInstall } from './lib/core.js';
import { statSync } from 'node:fs';

const wanted = process.argv[2] ?? 'nightly';
const install = findDesktopInstall();
const channel = channelTable('win32').find(row => row.id === wanted);
if (channel === undefined) throw new Error(`unknown channel: ${wanted}`);

console.log(`installed app version: ${install?.version}`);
const release = await resolveChannel(channel, { installedVersion: install?.version });
console.log('resolved:', JSON.stringify({
  id: release.id, available: release.available, source: release.source,
  version: release.version, size: release.size, upToDate: release.upToDate, reason: release.reason,
}, null, 2));
if (!release.available) throw new Error(`channel not available: ${release.reason}`);

const started = Date.now();
const job = new DownloadJob(release, process.argv[3] ?? 'D:\\DSH\\DSH Desktop\\_uplus-live-download');
const timer = setInterval(() => {
  const s = job.state;
  process.stdout.write(`\r  ${s.phase} ${s.percent}% ${(s.received / 1024 / 1024).toFixed(1)} MiB`
    + (s.total ? ` / ${(s.total / 1024 / 1024).toFixed(1)} MiB` : '') + '   ');
}, 2000);

const result = await job.run();
clearInterval(timer);
process.stdout.write('\n');
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('result:', JSON.stringify(result, null, 2));
if (result.phase !== 'done') {
  console.log(`LIVE DOWNLOAD FAILED after ${seconds}s`);
  process.exit(1);
}
const actual = statSync(result.file).size;
console.log(`\nLIVE DOWNLOAD OK in ${seconds}s`);
console.log(`  file    : ${result.file}`);
console.log(`  bytes   : ${actual} (manifest declared ${release.size})`);
console.log(`  verified: ${result.verified === true ? `SHA-512 matches ${release.manifest}` : 'no digest in manifest'}`);
process.exit(actual === release.size && result.verified === true ? 0 : 1);
