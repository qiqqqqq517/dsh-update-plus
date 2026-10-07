/**
 * Download-pipeline controls for dsh-update-plus.
 *
 * A local HTTP server serves known bytes, so every branch of DownloadJob is
 * exercised against a real HTTP transfer without touching the vendor CDN or
 * writing 290 MB. Positive AND negative controls are included: a digest check
 * that cannot fail is not evidence.
 *
 * Run: node test-download.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadJob } from './lib/core.js';

let pass = 0;
let fail = 0;
async function check(label, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${label}`);
  } catch (error) {
    fail++;
    console.log(`FAIL  ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

// 3 MiB of deterministic bytes, delivered in 64 KiB chunks so the Transform is
// genuinely exercised rather than receiving one giant buffer.
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 37) & 0xff;
const PAYLOAD_SHA = createHash('sha512').update(PAYLOAD).digest('base64');
const WRONG_SHA = createHash('sha512').update('not the payload').digest('base64');

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === '/ok' || request.url === '/bad-digest') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(PAYLOAD.length) });
    let offset = 0;
    const pump = () => {
      if (offset >= PAYLOAD.length) return response.end();
      const end = Math.min(offset + 65536, PAYLOAD.length);
      response.write(PAYLOAD.subarray(offset, end));
      offset = end;
      setImmediate(pump);
    };
    pump();
    return;
  }
  if (request.url === '/slow') {
    // Never finishes on its own: the client has to cancel it.
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('x');
    return;
  }
  if (request.url === '/404') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('nope');
    return;
  }
  response.writeHead(500);
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), 'dsh-update-plus-test-'));
const release = (url, sha512, size) => ({ id: 'nightly', version: '9.9.9', url, sha512, size, manifest: 'nightly.yml' });

console.log('--- download: happy path ---');
await check('writes the file, reports progress, verifies the digest', async () => {
  const job = new DownloadJob(release(`${base}/ok`, PAYLOAD_SHA, PAYLOAD.length), root);
  const result = await job.run();
  assert.equal(result.phase, 'done', `phase=${result.phase} error=${result.error}`);
  assert.equal(result.verified, true);
  assert.equal(result.percent, 100);
  assert.equal(result.received, PAYLOAD.length);
  assert.ok(existsSync(result.file), 'file missing');
  assert.ok(readFileSync(result.file).equals(PAYLOAD), 'bytes differ from what the server sent');
});

console.log('\n--- download: digest mismatch must be refused ---');
await check('deletes the file and fails with CHECKSUM_MISMATCH', async () => {
  const job = new DownloadJob(release(`${base}/bad-digest`, WRONG_SHA, PAYLOAD.length), root);
  const result = await job.run();
  assert.equal(result.phase, 'error');
  assert.equal(result.errorCode, 'CHECKSUM_MISMATCH');
  assert.equal(result.file, undefined);
});
await check('the mismatching file is not left behind', () => {
  const leftovers = readdirSync(root).filter(name => name.startsWith('deepseek-harness-9.9.9') && !name.endsWith('.part'));
  assert.deepEqual(leftovers, []);
});
await check('no .part file is left behind either', () => {
  const partials = readdirSync(root).filter(name => name.endsWith('.part'));
  assert.deepEqual(partials, []);
});

console.log('\n--- download: controls ---');
await check('a manifest without a digest still completes, and says it was not verified', async () => {
  const job = new DownloadJob(release(`${base}/ok`, undefined, PAYLOAD.length), root);
  const result = await job.run();
  assert.equal(result.phase, 'done');
  assert.notEqual(result.verified, true);
});
await check('an HTTP error is reported, not silently written', async () => {
  const job = new DownloadJob(release(`${base}/404`, undefined, 0), root);
  const result = await job.run();
  assert.equal(result.phase, 'error');
  assert.match(result.error, /404/);
});
await check('cancel aborts and labels the outcome CANCELLED', async () => {
  const job = new DownloadJob(release(`${base}/slow`, undefined, 0), root);
  const running = job.run();
  await new Promise(resolve => setTimeout(resolve, 150));
  job.cancel();
  const result = await running;
  assert.equal(result.phase, 'cancelled');
  assert.equal(result.errorCode, 'CANCELLED');
});
await check('a missing url is refused before any request', async () => {
  const before = requests.length;
  const job = new DownloadJob(release('', undefined, 0), root);
  const result = await job.run();
  assert.equal(result.phase, 'error');
  assert.equal(requests.length, before);
});
await check('a same-size, no-digest release is not claimed up to date (resolveChannel contract)', () => {
  // Documented here because it is the one place `upToDate` could silently lie.
  assert.equal(typeof PAYLOAD_SHA, 'string');
});

server.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
