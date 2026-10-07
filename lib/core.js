/**
 * dsh-update-plus — core: update channels, feed resolution, version comparison,
 * installed-version discovery, streamed download and the restart supervisor.
 *
 * Everything in this file is plain Node; it never imports Electron. The desktop
 * shell is a different process (the harness host is a child of it), so anything
 * that needs Electron is out of reach by construction and is either avoided or
 * handled by re-launching the app from outside (see `restartDetached`).
 *
 * @module dsh-update-plus/core
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The official electron-builder `generic` feed roots, measured 2026-10-07.
 * The desktop build itself hard-codes `channel = 'nightly'`; exposing the other
 * names is the point of this plugin.
 */
const FEED_ROOTS = {
  win32: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
  darwin: 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/',
};

/**
 * Manifest file names inside a feed root. electron-updater asks for
 * `<channel>.yml` (and `<channel>-mac.yml` on macOS); `stable` is the
 * electron-builder default name `latest`.
 */
const MANIFEST_NAMES = {
  win32: { stable: 'latest.yml', beta: 'beta.yml', nightly: 'nightly.yml' },
  darwin: { stable: 'latest-mac.yml', beta: 'beta-mac.yml', nightly: 'nightly-mac.yml' },
};

/**
 * The vendor's own "download the desktop app" links, published on
 * https://www.deepseek.com/download. They are not an electron-updater feed —
 * there is no manifest and therefore no version in the response — so they are
 * used only as a fallback artifact for the `stable` channel, and the version is
 * inferred by matching the artifact size against a known manifest.
 */
const OFFICIAL_STABLE_URL = {
  win32: 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe',
  darwin: 'https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg',
};

/** Every channel this plugin knows how to talk about, in display order. */
export const CHANNEL_IDS = ['stable', 'beta', 'nightly'];

/** @returns the channel table for a platform, with resolved manifest URLs. */
export function channelTable(platform = process.platform) {
  const root = FEED_ROOTS[platform] ?? FEED_ROOTS.win32;
  const names = MANIFEST_NAMES[platform] ?? MANIFEST_NAMES.win32;
  return CHANNEL_IDS.map(id => ({
    id,
    manifest: names[id],
    manifestUrl: new URL(names[id], root).href,
    artifactUrl: id === 'stable' ? (OFFICIAL_STABLE_URL[platform] ?? OFFICIAL_STABLE_URL.win32) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/**
 * Rewrite YAML block scalars (`>-`, `|`, `|-` …) onto the key's own line so the
 * tiny line parser below sees one `key: value` per line.
 *
 * electron-builder writes long URLs and sha512 digests as folded scalars, so a
 * naive `key: value` reader reports an empty `path` on exactly the manifests
 * that matter. Folded scalars join their indented lines with a space, but these
 * values never wrap mid-token in practice and the parser strips the space again
 * by trimming each fragment before joining.
 * @param text - raw YAML.
 * @returns YAML with block scalars unfolded.
 */
function unfoldBlockScalars(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)([A-Za-z0-9_-]+):\s*[>|][-+]?\s*$/.exec(lines[i]);
    if (open === null) {
      out.push(lines[i]);
      continue;
    }
    const indent = open[1];
    const parts = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const lead = /^\s*/.exec(line)[0].length;
      if (lead <= indent.length) break;
      parts.push(line.trim());
    }
    out.push(`${indent}${open[2]}: ${parts.join('')}`);
    i = j - 1;
  }
  return out.join('\n');
}

/** Strip one layer of YAML quoting. */
function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Parse the handful of fields this plugin needs out of an electron-builder
 * `latest.yml`. Deliberately not a general YAML parser: the manifest is a
 * generated, fixed-shape document, and a whole-library dependency would be the
 * only runtime dependency this plugin has.
 *
 * @param text - raw manifest text.
 * @returns the resolved release, or undefined when the document is not a manifest.
 */
export function parseManifest(text) {
  const unfolded = unfoldBlockScalars(text);
  const lines = unfolded.split(/\r?\n/);
  const top = {};
  let currentFile = undefined;
  const files = [];

  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const fileEntry = /^\s*-\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (fileEntry !== null) {
      currentFile = { [fileEntry[1]]: unquote(fileEntry[2]) };
      files.push(currentFile);
      continue;
    }
    const pair = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const [, indent, key, rawValue] = pair;
    const value = unquote(rawValue);
    if (indent.length > 0) {
      if (currentFile !== undefined) currentFile[key] = value;
      continue;
    }
    currentFile = undefined;
    top[key] = value;
  }

  const primary = files[0] ?? {};
  const version = top.version;
  if (typeof version !== 'string' || version.trim() === '') return undefined;
  const url = top.path !== undefined && top.path !== '' ? top.path : primary.url;
  const sha512 = top.sha512 !== undefined && top.sha512 !== '' ? top.sha512 : primary.sha512;
  const size = Number(top.size ?? primary.size ?? 0);
  return {
    version: version.trim(),
    url: typeof url === 'string' ? url : undefined,
    sha512: typeof sha512 === 'string' ? sha512 : undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
    releaseDate: typeof top.releaseDate === 'string' ? unquote(top.releaseDate) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two versions the way electron-updater's `semver` does for the cases
 * this feed produces (`0.2.0-rc.2`, `0.1.7-rc.1.20260924.1`, `0.2.1-alpha.1`).
 *
 * Prerelease ordering matters here: `0.2.0-rc.2` is NEWER than `0.2.0-rc.1` but
 * OLDER than `0.2.0`. A plain string compare gets the second one backwards, and
 * a stable channel that silently reports "up to date" while an older rc is
 * installed is the exact failure this plugin exists to avoid.
 *
 * @returns a negative number, zero, or a positive number.
 */
export function compareVersions(left, right) {
  const split = value => {
    const [core, ...rest] = String(value).trim().replace(/^v/u, '').split('-');
    const numbers = core.split('.').map(part => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    // Dot-separated prerelease identifiers, each numeric when it looks numeric.
    const pre = rest.join('-').split('.').filter(part => part !== '').map(part => {
      const n = Number.parseInt(part, 10);
      return /^\d+$/u.test(part) && Number.isFinite(n) ? n : part;
    });
    return { numbers, pre };
  };

  const a = split(left);
  const b = split(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  // A release outranks any prerelease of the same core version.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const preLength = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < preLength; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Installed version discovery
// ---------------------------------------------------------------------------

/**
 * Read one JSON document out of an asar archive.
 *
 * TWO READERS, and the order matters. MEASURED on the official build: the
 * harness host is the Electron binary re-entered as Node with the asar layer
 * ACTIVE, so `resources/app.asar` is not a file to it — `statSync().size` is 0,
 * `isDirectory()` is true, and `<archive>\package.json` simply opens. Reading
 * the archive's raw bytes there fails with
 * `ENOENT, not found in D:\DSH\resources\app.asar`.
 *
 * The raw header parser is therefore the fallback, for a plain Node process
 * (`ELECTRON_NO_ASAR=1`, or a test harness) where the archive really is a file.
 *
 * @param asarPath - the archive.
 * @param entryPath - slash-separated path inside the archive.
 * @returns the parsed JSON, or undefined when it cannot be read either way.
 */
function readAsarJson(asarPath, entryPath) {
  const segments = entryPath.split('/').filter(part => part !== '');

  // Reader 1: the asar layer presents the archive as a directory.
  try {
    const direct = readFileSync(join(asarPath, ...segments), 'utf8');
    return JSON.parse(direct);
  } catch { /* the layer is off, or the entry is absent — fall through */ }

  // Reader 2: parse the raw archive.
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const sizeBuffer = Buffer.alloc(8);
    readSync(fd, sizeBuffer, 0, 8, 0);
    const headerSize = sizeBuffer.readUInt32LE(4);
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) return undefined;
    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, 8);
    const jsonLength = headerBuffer.readUInt32LE(4);
    const header = JSON.parse(headerBuffer.toString('utf8', 8, 8 + jsonLength));

    let node = header;
    for (const segment of segments) {
      node = node?.files?.[segment];
      if (node === undefined || node === null) return undefined;
    }
    // MEASURED: the asar header stores `offset` as a STRING (the format keeps it
    // out of float precision range), so a `typeof === 'number'` test rejects
    // every entry and the reader silently reports "no version" — the failure the
    // two-reader test exists to catch.
    const offset = Number(node.offset);
    if (!Number.isFinite(offset)) return undefined;

    const contentBase = 8 + headerSize;
    const buffer = Buffer.alloc(node.size);
    readSync(fd, buffer, 0, node.size, contentBase + offset);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Derive an installation root from any path that spells the app archive out.
 *
 * MEASURED on the official Windows build: the harness host is not a separate
 * `node.exe` — it is the Electron binary re-entered as Node, so
 * `process.execPath` is `<root>\DeepSeek Harness.exe` and `process.argv[1]` is
 * `<root>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`.
 * The archive segment is therefore the most exact signal available, and it
 * survives an install that is not two levels under the executable.
 *
 * @param value - a path that may contain a `resources/app.asar` segment.
 * @returns the root before that segment, or undefined.
 */
function rootFromArchivePath(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const normalized = value.replace(/\\/gu, '/');
  for (const marker of ['/resources/app.asar', '/resources/app/']) {
    const index = normalized.lastIndexOf(marker);
    if (index > 0) return normalized.slice(0, index);
  }
  return undefined;
}

/** True when `root` holds a desktop installation. */
function isInstallRoot(root) {
  if (typeof root !== 'string' || root === '') return false;
  return existsSync(join(root, 'resources', 'app.asar')) || existsSync(join(root, 'resources', 'app', 'package.json'));
}

/**
 * Locate the installed desktop application.
 *
 * The harness host runs inside the installation, so its own `execPath`/`argv`
 * locate the root exactly; the walk-up and the well-known locations are only
 * there for layouts that moved things. An explicit `installRoot` config always
 * wins.
 *
 * @param explicitRoot - optional configured installation root.
 * @returns the discovered layout, or undefined when nothing looks like an install.
 */
export function findDesktopInstall(explicitRoot) {
  const candidates = [];
  const push = value => {
    if (typeof value === 'string' && value !== '' && !candidates.includes(value)) candidates.push(value);
  };

  push(explicitRoot);

  // 1. Exact: a path that spells `resources\app.asar` out.
  for (const seed of [process.argv?.[1], process.execPath, process.argv?.[0]]) {
    const root = rootFromArchivePath(seed);
    if (root !== undefined) push(root);
  }

  // 2. Walk up from the executable and from the host entry point.
  for (const seed of [process.execPath, process.argv?.[1]]) {
    if (typeof seed !== 'string' || seed === '') continue;
    let level = dirname(seed.replace(/\\/gu, '/'));
    for (let i = 0; i < 6; i++) {
      push(level);
      const parent = dirname(level);
      if (parent === level) break;
      level = parent;
    }
  }

  // 3. Well-known installation locations.
  if (process.platform === 'win32') {
    push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'));
    push(join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness'));
  } else if (process.platform === 'darwin') {
    push('/Applications/DeepSeek Harness.app');
  }
  push(process.env.DSH_DESKTOP_INSTALL_ROOT);

  for (const root of candidates) {
    if (!isInstallRoot(root)) continue;
    const asarPath = join(root, 'resources', 'app.asar');
    if (existsSync(asarPath)) {
      const manifest = readAsarJson(asarPath, 'package.json');
      return {
        root,
        packed: true,
        appPath: asarPath,
        version: typeof manifest?.version === 'string' ? manifest.version : undefined,
        productName: typeof manifest?.name === 'string' ? manifest.name : 'DeepSeek Harness',
        dshBuildCommit: typeof manifest?.dshBuildCommit === 'string' ? manifest.dshBuildCommit : undefined,
      };
    }
    const dirPath = join(root, 'resources', 'app');
    const dirManifest = join(dirPath, 'package.json');
    let version;
    let productName;
    try {
      const parsed = JSON.parse(readFileSync(dirManifest, 'utf8'));
      version = typeof parsed?.version === 'string' ? parsed.version : undefined;
      productName = typeof parsed?.name === 'string' ? parsed.name : undefined;
    } catch { /* unreadable manifest is not a fatal install problem */ }
    return {
      root,
      packed: false,
      appPath: dirPath,
      version,
      productName: productName ?? 'DeepSeek Harness',
    };
  }
  return undefined;
}

/**
 * The bundled dsh runtime version, read from `<app>/dsh/package.json`.
 *
 * The desktop shell reads the same value to build `x-client-bundled-dsh-version`,
 * and the panel shows it so "which harness am I on" never has to be guessed from
 * the app version alone.
 *
 * @param install - a layout from {@link findDesktopInstall}.
 * @returns the version, or undefined when it cannot be read.
 */
export function readBundledDshVersion(install) {
  if (install === undefined) return undefined;
  const parsed = install.packed
    // `dsh/package.json` is inside the archive, not in the sibling `.unpacked`
    // directory (that one holds the native modules only).
    ? readAsarJson(install.appPath, 'dsh/package.json')
    : (() => {
      const candidate = join(install.appPath, 'dsh', 'package.json');
      if (!existsSync(candidate)) return undefined;
      try { return JSON.parse(readFileSync(candidate, 'utf8')); } catch { return undefined; }
    })();
  return typeof parsed?.version === 'string' ? parsed.version : undefined;
}

/** The executable the restart supervisor should launch again. */
export function resolveLauncher(install, platform = process.platform) {
  if (install === undefined) return undefined;
  if (platform === 'win32') {
    for (const name of ['DeepSeek Harness.exe', 'deepseek-harness.exe', 'DeepSeekHarness.exe']) {
      const candidate = join(install.root, name);
      if (existsSync(candidate)) return candidate;
    }
    // Fall back to whatever .exe sits next to the resources directory.
    return undefined;
  }
  return join(install.root, 'DeepSeek Harness.app');
}

/** The updater configuration the shell itself obeys — the honest "what is my channel" source. */
export function readAppUpdateConfig(install) {
  if (install === undefined) return undefined;
  const candidate = join(install.root, 'resources', 'app-update.yml');
  if (!existsSync(candidate)) return undefined;
  try {
    const text = readFileSync(candidate, 'utf8');
    const read = key => {
      const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mu').exec(text);
      return match === null ? undefined : unquote(match[1]);
    };
    return { path: candidate, provider: read('provider'), url: read('url'), channel: read('channel') };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const USER_AGENT = 'dsh-update-plus/1.0.0 (DeepSeek Harness)';

/** Fetch with a timeout that also covers a stalled body. */
async function request(url, { method = 'GET', timeoutMs = 30_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const relay = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
  }
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', relay);
  }
}

/**
 * Resolve one channel into a concrete release.
 *
 * @param channel - a row from {@link channelTable}.
 * @param options - `installedVersion` for the up-to-date decision, `signal` to cancel.
 * @returns the resolved release; `available:false` is a normal outcome, not an error.
 */
export async function resolveChannel(channel, options = {}) {
  const { installedVersion, signal } = options;
  const result = {
    id: channel.id,
    manifest: channel.manifest,
    manifestUrl: channel.manifestUrl,
    available: false,
    source: 'feed',
  };

  try {
    const response = await request(channel.manifestUrl, { timeoutMs: 20_000, signal });
    if (response.status === 404) {
      result.reason = 'channel-not-published';
      result.detail = `${channel.manifest} 尚未在官方源发布（HTTP 404）`;
    } else if (!response.ok) {
      result.reason = 'feed-error';
      result.detail = `官方源返回 HTTP ${response.status}`;
    } else {
      const parsed = parseManifest(await response.text());
      if (parsed === undefined) {
        result.reason = 'bad-manifest';
        result.detail = `${channel.manifest} 不是可解析的更新清单`;
      } else {
        Object.assign(result, {
          available: true,
          version: parsed.version,
          url: parsed.url,
          sha512: parsed.sha512,
          size: parsed.size,
          releaseDate: parsed.releaseDate,
        });
      }
    }
  } catch (error) {
    result.reason = 'network-error';
    result.detail = String(error?.message ?? error);
  }

  // The stable channel has a vendor-published artifact even when no `latest.yml`
  // exists yet. HEAD it so the panel can still offer a real download.
  if (!result.available && result.reason === 'channel-not-published' && typeof channel.artifactUrl === 'string') {
    try {
      const head = await request(channel.artifactUrl, { method: 'HEAD', timeoutMs: 20_000, signal });
      if (head.ok) {
        const length = Number(head.headers.get('content-length') ?? 0);
        result.available = true;
        result.source = 'official-link';
        result.url = channel.artifactUrl;
        result.size = Number.isFinite(length) && length > 0 ? length : undefined;
        result.releaseDate = head.headers.get('last-modified') ?? undefined;
        result.versionInferred = true;
        result.detail = '官方尚未发布该通道的更新清单；以下为官网「下载桌面版」直链（版本号由构建信息推断）';
      }
    } catch { /* the panel then reports the channel as unpublished, which is accurate */ }
  }

  if (result.available && typeof installedVersion === 'string' && installedVersion !== '') {
    if (typeof result.version === 'string') {
      result.upToDate = compareVersions(result.version, installedVersion) <= 0;
    } else {
      // No version in hand: a same-size artifact is the only reliable same-build signal.
      result.upToDate = false;
    }
  }
  return result;
}

/**
 * Ask every channel in parallel, then fill in the version of a size-only
 * artifact by matching it against a manifest that does carry one.
 *
 * @param options - `installedVersion`, `platform`, `signal`, `onChannel`.
 * @returns every channel's resolution, in table order.
 */
export async function resolveAllChannels(options = {}) {
  const { installedVersion, platform = process.platform, signal, onChannel } = options;
  const table = channelTable(platform);
  const resolved = await Promise.all(table.map(channel => resolveChannel(channel, { installedVersion, signal })));

  const known = new Map(resolved.filter(item => typeof item.size === 'number' && typeof item.version === 'string')
    .map(item => [item.size, item]));
  for (const item of resolved) {
    if (item.available && typeof item.version !== 'string' && typeof item.size === 'number') {
      const match = known.get(item.size);
      if (match !== undefined) {
        item.version = match.version;
        item.versionSource = `与 ${match.id} 通道同尺寸构建：${match.version}`;
      }
    }
    if (item.available && typeof item.version === 'string' && typeof installedVersion === 'string' && installedVersion !== '') {
      item.upToDate = compareVersions(item.version, installedVersion) <= 0;
    }
    if (typeof onChannel === 'function') onChannel(item);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** One in-flight download, polled by the panel. */
export class DownloadJob {
  /** @param release - the resolved channel to fetch. @param directory - where to write it. */
  constructor(release, directory) {
    this.release = release;
    this.directory = directory;
    this.controller = new AbortController();
    this.state = {
      active: true,
      phase: 'starting',
      received: 0,
      total: typeof release.size === 'number' ? release.size : 0,
      percent: 0,
      url: release.url,
      version: release.version,
      file: undefined,
      error: undefined,
      errorCode: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
    };
  }

  /** Best-effort file name from the release URL. */
  fileName() {
    const fromUrl = (() => {
      try {
        const name = basename(new URL(this.release.url).pathname);
        return name === '' || name === '/' ? undefined : name;
      } catch {
        return undefined;
      }
    })();
    if (fromUrl !== undefined) return fromUrl;
    const version = this.release.version ?? 'latest';
    return process.platform === 'darwin'
      ? `deepseek-harness-${version}.dmg`
      : `deepseek-harness-${version}-win-x64.exe`;
  }

  /** Run the download to completion, verifying the digest before publishing the path. */
  async run() {
    let partial;
    try {
      if (typeof this.release.url !== 'string' || this.release.url === '') throw new Error('该通道没有可下载的安装包地址');
      mkdirSync(this.directory, { recursive: true });
      const target = join(this.directory, this.fileName());
      // A fresh attempt must never resume into a half-written predecessor.
      partial = `${target}.part`;
      rmSync(partial, { force: true });

      const response = await request(this.release.url, { timeoutMs: 60_000, signal: this.controller.signal });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      if (response.body === null) throw new Error('下载失败：响应没有内容');

      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > 0) this.state.total = declared;
      this.state.phase = 'downloading';

      const hash = createHash('sha512');
      let received = 0;
      // Counting happens in a Transform rather than in a `data` listener: adding
      // a `data` handler switches the readable into flowing mode, which races
      // `pipeline` and can drop the first chunks into the void. A Transform sits
      // in the pipe, so every byte is hashed exactly once and still reaches the
      // file.
      const counter = new Transform({
        transform: (chunk, _encoding, callback) => {
          received += chunk.length;
          hash.update(chunk);
          this.state.received = received;
          this.state.percent = this.state.total > 0
            ? Math.min(100, Math.round((received / this.state.total) * 1000) / 10)
            : 0;
          callback(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial), { signal: this.controller.signal });
      this.state.phase = 'verifying';

      const expected = typeof this.release.sha512 === 'string' && this.release.sha512 !== '' ? this.release.sha512 : undefined;
      if (expected !== undefined) {
        const actual = hash.digest('base64');
        if (actual !== expected) {
          rmSync(partial, { force: true });
          const failure = new Error('校验失败：下载文件的 SHA-512 与官方清单不一致，已删除');
          failure.code = 'CHECKSUM_MISMATCH';
          throw failure;
        }
      }

      // Publish atomically: a caller must never see a `.part` as the result.
      rmSync(target, { force: true });
      renameSync(partial, target);
      this.state.file = target;
      this.state.size = statSync(target).size;
      this.state.verified = expected !== undefined;
      this.state.phase = 'done';
      this.state.percent = 100;
    } catch (error) {
      if (partial !== undefined) {
        try { rmSync(partial, { force: true }); } catch { /* nothing to clean */ }
      }
      const cancelled = this.controller.signal.aborted;
      this.state.phase = cancelled ? 'cancelled' : 'error';
      this.state.errorCode = cancelled ? 'CANCELLED' : (error?.code ?? 'DOWNLOAD_FAILED');
      this.state.error = String(error?.message ?? error);
    } finally {
      this.state.active = false;
      this.state.finishedAt = Date.now();
    }
    return this.state;
  }

  /** Abort the transfer; the panel sees phase `cancelled`. */
  cancel() {
    this.controller.abort(new Error('cancelled by user'));
  }
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

/**
 * Restart the desktop application, and with it the harness host.
 *
 * WHY A DETACHED SCRIPT
 * The shell's own "restart app and host" action calls `app.relaunch()` and only
 * exists in a development build. This plugin runs in the harness host, a plain
 * Node child that has no Electron API and cannot ask its parent to quit or
 * relaunch — and it is also the process that dies with the app. So the restart
 * is handed to a detached `cmd` script that survives the app's exit: it waits,
 * closes the app, waits for the process to actually disappear, and starts the
 * launcher again.
 *
 * `taskkill /F` is used because the shell's window `close` handler hides to the
 * tray instead of quitting (`lib/main.js`: `event.preventDefault()` then
 * `hideMainWindow`), so a graceful close signal would leave the app running and
 * the relaunch would produce a second, tray-only instance. The panel therefore
 * warns before it calls this, and the script waits the same grace period the
 * warning promises.
 *
 * @param options - `install`, `launcher`, `delayMs` grace period, `dataDir` for the log.
 * @returns the written plan (script path and log path), or the reason it cannot run.
 */
export function buildRestartPlan(options = {}) {
  const { install, launcher, delayMs = 3000, dataDir } = options;
  if (process.platform !== 'win32') {
    return { ok: false, errorCode: 'UNSUPPORTED_PLATFORM', error: '这个重启方式目前只支持 Windows；macOS 请用菜单里的「重启应用与 Host」。' };
  }
  const executable = launcher ?? resolveLauncher(install);
  if (typeof executable !== 'string' || executable === '') {
    return { ok: false, errorCode: 'NO_LAUNCHER', error: '找不到 DeepSeek Harness.exe，无法自动重启。可在插件设置里手动指定安装目录。' };
  }
  const scriptDir = dataDir ?? join(homedir(), '.dsh', 'dsh-update-plus');
  mkdirSync(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, 'restart.cmd');
  const logPath = join(scriptDir, 'restart.log');
  const exeName = basename(executable);
  const seconds = Math.max(1, Math.round(delayMs / 1000));

  // Written as CRLF: this is a batch file, and cmd.exe mis-parses LF-only files
  // around labels and multi-line blocks.
  const script = [
    '@echo off',
    'setlocal',
    `echo [%date% %time%] restart requested >> "${logPath}"`,
    `ping -n ${seconds + 1} 127.0.0.1 >nul`,
    `taskkill /IM "${exeName}" /F >> "${logPath}" 2>&1`,
    ':waitloop',
    'ping -n 2 127.0.0.1 >nul',
    `tasklist /FI "IMAGENAME eq ${exeName}" 2>nul | find /I "${exeName}" >nul && goto waitloop`,
    `echo [%date% %time%] relaunching "${executable}" >> "${logPath}"`,
    `start "" "${executable}"`,
    'echo [%date% %time%] done >> "${logPath}"',
    'endlocal',
    '',
  ].join('\r\n');
  writeFileSync(scriptPath, script, 'utf8');

  return { ok: true, scriptPath, logPath, executable, delayMs, exeName };
}

/** Launch `cmd.exe` on the restart script, fully detached from this process tree. */
export async function scheduleRestart(options = {}) {
  const plan = buildRestartPlan(options);
  if (!plan.ok) return plan;
  const { spawn } = await import('node:child_process');
  const child = spawn('cmd.exe', ['/c', plan.scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, scriptPath: plan.scriptPath, logPath: plan.logPath, executable: plan.executable, pid: child.pid, delayMs: plan.delayMs };
}

/** Open a downloaded installer with the shell's own association (user-visible action). */
export async function launchFile(file) {
  if (typeof file !== 'string' || file === '' || !existsSync(file)) {
    return { ok: false, error: '安装包文件不存在，请先下载。' };
  }
  const { spawn } = await import('node:child_process');
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } else {
    const child = spawn('open', [file], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  return { ok: true, file };
}
