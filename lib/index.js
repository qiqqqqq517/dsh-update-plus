/**
 * dsh-update-plus — host half.
 *
 * Owns everything that must happen outside the renderer: resolving the official
 * update feeds, discovering the installed desktop build, streaming an installer
 * to disk with digest verification, and scheduling the restart. The panel (the
 * client half in `lib/client.js`) is a pure view over the JSON API served here.
 *
 * The server is the transport on purpose: the renderer and this process already
 * share one origin through the harness web server, and a plain HTTP route keeps
 * the whole plugin free of build steps and of any dependency on the generated
 * Remote/typert surface, which changes between harness releases.
 *
 * @module dsh-update-plus
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DownloadJob,
  channelTable,
  findDesktopInstall,
  launchFile,
  readAppUpdateConfig,
  readBundledDshVersion,
  resolveAllChannels,
  resolveLauncher,
  scheduleRestart,
} from './core.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-update-plus';

/**
 * No required dependency: the plugin applies everywhere and waits for the web
 * server itself (`ctx.inject(['webServer'], …)` below). Declaring `webServer`
 * as required would park the plugin in a pending state on a surface that never
 * mounts one, which is worse than loading with the panel simply unreachable.
 */

/**
 * Defaults for the plugin configuration.
 *
 * NOT exported as `Config`. The loader treats a `Config` export as a
 * schemastery SCHEMA and calls it; a plain object throws inside the loader and
 * the plugin surfaces only as an opaque `fiberPhase: failed` with no usable
 * stack from the panel side. This plugin therefore declares no schema (every
 * setting is optional and validated here) rather than adding a dependency on
 * `@deepseek-ai/schemastery` for four fields — and it means the patch row can
 * stay `config: {}`.
 */
const DEFAULTS = {
  installRoot: '',
  downloadDir: '',
  channel: 'nightly',
  restartDelayMs: 3000,
};

/** Read one field off the raw patch config, falling back to the default. */
function resolveConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (key, fallback) => typeof value[key] === 'string' ? value[key] : fallback;
  const number = (key, fallback) => Number.isFinite(value[key]) ? value[key] : fallback;
  return {
    installRoot: text('installRoot', DEFAULTS.installRoot),
    downloadDir: text('downloadDir', DEFAULTS.downloadDir),
    channel: text('channel', DEFAULTS.channel),
    restartDelayMs: Math.max(500, Math.min(60_000, number('restartDelayMs', DEFAULTS.restartDelayMs))),
  };
}

const ROUTE = '/dsh-update-plus/api';
const MAX_BODY_BYTES = 64 * 1024;

/** Resolve a plugin-owned data directory, honouring `DSH_HOME`. */
function dataDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'dsh-update-plus');
}

/** Read persisted settings, filling any gap with the plugin config defaults. */
function readSettings(config) {
  const defaults = {
    channel: config.channel ?? 'nightly',
    downloadDir: config.downloadDir !== undefined && config.downloadDir !== ''
      ? config.downloadDir
      : join(dataDir(), 'downloads'),
    installRoot: config.installRoot ?? '',
    restartDelayMs: Number.isFinite(config.restartDelayMs) ? config.restartDelayMs : 3000,
  };
  const path = join(dataDir(), 'settings.json');
  if (!existsSync(path)) return { settings: defaults, path };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path,
      settings: {
        channel: typeof parsed.channel === 'string' && parsed.channel !== '' ? parsed.channel : defaults.channel,
        downloadDir: typeof parsed.downloadDir === 'string' && parsed.downloadDir !== '' ? parsed.downloadDir : defaults.downloadDir,
        installRoot: typeof parsed.installRoot === 'string' ? parsed.installRoot : defaults.installRoot,
        restartDelayMs: Number.isFinite(parsed.restartDelayMs) ? parsed.restartDelayMs : defaults.restartDelayMs,
      },
    };
  } catch {
    return { settings: defaults, path };
  }
}

/** Persist settings atomically enough for a single-writer settings file. */
function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

/**
 * Whether a request may touch this API.
 *
 * The panel is a same-origin document: the shell's own page calls this route
 * with no `Origin` at all (Chromium attaches no cross-origin metadata to a
 * request leaving a custom `dsh-app:` scheme), so the rule cannot be "an
 * absent Origin is a script" — that refuses every real panel request. Writes
 * additionally require a fetch-shaped request, which a hand-rolled client does
 * not send.
 *
 * @param request - the incoming request.
 * @param writing - true for state-changing actions.
 * @returns whether the request is admitted.
 */
function admit(request, writing) {
  const origin = String(request.headers.origin ?? '').trim();
  if (origin === '') {
    if (!writing) return true;
    const agent = String(request.headers['user-agent'] ?? '');
    const agent_ok = /^Mozilla\/5\.0/u.test(agent) || /dsh-update-plus/u.test(agent);
    return agent_ok && String(request.headers['accept-language'] ?? '') !== '';
  }
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'dsh-app:' || parsed.protocol === 'dsh-desktop:') return true;
    return parsed.host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Read and parse a JSON request body with a hard size cap. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Register the plugin.
 * @param ctx - the cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  let install = findDesktopInstall(resolved.installRoot);
  let activeDownload;
  let lastResult;

  /** Recompute the installation view; cheap, and it must never throw into a request. */
  const snapshotInstall = () => {
    install = findDesktopInstall(resolved.installRoot);
    const launcher = resolveLauncher(install);
    return {
      found: install !== undefined,
      root: install?.root,
      packed: install?.packed,
      appVersion: install?.version,
      bundledDshVersion: readBundledDshVersion(install),
      launcher,
      updater: readAppUpdateConfig(install),
      platform: process.platform,
      arch: process.arch,
      hostVersion: process.versions.node,
    };
  };

  const api = {
    async state() {
      const { settings, path } = readSettings(resolved);
      return {
        ok: true,
        install: snapshotInstall(),
        settings,
        settingsPath: path,
        dataDir: dataDir(),
        channels: channelTable(process.platform).map(row => ({ id: row.id, manifest: row.manifest, manifestUrl: row.manifestUrl })),
        download: activeDownload?.state,
        lastResult,
      };
    },

    async check() {
      const { settings } = readSettings(resolved);
      const installed = install?.version;
      const results = await resolveAllChannels({
        installedVersion: installed,
        platform: process.platform,
      });
      lastResult = { at: new Date().toISOString(), installedVersion: installed, channels: results };
      return { ok: true, ...lastResult };
    },

    async download(body) {
      if (activeDownload?.state.active === true) {
        return { ok: false, error: '已有下载在进行中。', download: activeDownload.state };
      }
      const { settings } = readSettings(resolved);
      const channelId = typeof body.channel === 'string' && body.channel !== '' ? body.channel : settings.channel;
      const installed = install?.version;
      const results = await resolveAllChannels({ installedVersion: installed, platform: process.platform });
      const chosen = results.find(item => item.id === channelId);
      if (chosen === undefined) return { ok: false, error: `未知通道：${channelId}` };
      if (!chosen.available) return { ok: false, error: chosen.detail ?? `${channelId} 通道当前没有可下载的安装包。`, channel: chosen };
      if (typeof chosen.url !== 'string' || chosen.url === '') return { ok: false, error: '该通道的更新清单里没有下载地址。', channel: chosen };

      const job = new DownloadJob(chosen, settings.downloadDir);
      activeDownload = job;
      // Resolve immediately and let the panel poll: a 290 MB download must not
      // hold an HTTP request open.
      job.run().catch(() => { /* state already carries the failure */ });
      return { ok: true, started: true, channel: chosen, download: job.state };
    },

    async cancel() {
      if (activeDownload === undefined) return { ok: true, cancelled: false };
      activeDownload.cancel();
      return { ok: true, cancelled: true };
    },

    async progress() {
      return { ok: true, download: activeDownload?.state };
    },

    async restart(body) {
      const { settings } = readSettings(resolved);
      const delay = Number.isFinite(body.delayMs) ? body.delayMs : settings.restartDelayMs;
      const result = await scheduleRestart({
        install,
        launcher: resolveLauncher(install),
        delayMs: delay,
        dataDir: dataDir(),
      });
      return result.ok ? { ok: true, ...result, note: `已在 ${Math.round(delay / 1000)} 秒后重启应用与 Host。` } : result;
    },

    async openFile(body) {
      const file = typeof body.file === 'string' && body.file !== '' ? body.file : activeDownload?.state.file;
      return launchFile(file);
    },

    async settings(body) {
      const { settings: current, path } = readSettings(resolved);
      const patch = body.settings !== undefined && typeof body.settings === 'object' && body.settings !== null ? body.settings : {};
      const next = {
        channel: typeof patch.channel === 'string' && patch.channel !== '' ? patch.channel : current.channel,
        downloadDir: typeof patch.downloadDir === 'string' && patch.downloadDir !== '' ? patch.downloadDir : current.downloadDir,
        installRoot: typeof patch.installRoot === 'string' ? patch.installRoot : current.installRoot,
        restartDelayMs: Number.isFinite(patch.restartDelayMs) ? Math.max(500, Math.min(60_000, patch.restartDelayMs)) : current.restartDelayMs,
      };
      writeSettings(path, next);
      if (next.installRoot !== current.installRoot) install = findDesktopInstall(next.installRoot);
      return { ok: true, settings: next, settingsPath: path, install: snapshotInstall() };
    },
  };

  const handler = async (request, response) => {
    const json = (status, payload) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(request.url ?? ROUTE, 'http://localhost');
      const action = url.searchParams.get('action') ?? 'state';
      const method = (request.method ?? 'GET').toUpperCase();
      const writing = method !== 'GET' && method !== 'HEAD';
      if (!admit(request, writing)) {
        json(403, { ok: false, error: 'cross-origin request refused' });
        return;
      }
      const body = writing ? await readJsonBody(request) : {};
      const run = api[action];
      if (typeof run !== 'function') {
        json(404, { ok: false, error: `unknown action: ${action}` });
        return;
      }
      json(200, await run(body));
    } catch (error) {
      json(500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  ctx.inject(['webServer'], host => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler,
    }, 'dsh-update-plus: update and restart API'));
  });
}
