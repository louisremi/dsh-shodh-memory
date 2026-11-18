/**
 * Tests for the managed `shodh-tui` install.
 *
 * A local HTTP server plays GitHub: it serves a release document and a tiny
 * `.tar.gz` built in memory. The installer is pointed at it through its
 * `apiBase` parameter, so nothing here touches the network.
 *
 * What is pinned: which archive each platform asks for, that a digest mismatch
 * or a missing digest installs nothing, and that exactly one file — `shodh-tui`
 * at the archive root — ever reaches the disk.
 *
 * Run: `pnpm test`
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  installedPath,
  installTui,
  listInstalled,
  normalizeTag,
  type ReleaseTag,
  releaseAsset,
  TuiInstallError,
  tuiRoot,
} from '../src/tui-install.js';

/** A known-good tag; production code gets them from `normalizeTag` too. */
function tag(version: string): ReleaseTag {
  const normalized = normalizeTag(version);
  assert.ok(normalized, `${version} is a tag`);
  return normalized;
}

let passed = 0;
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── a tar writer just big enough for the fixtures ────────────────────────────

interface TarEntry {
  name: string;
  data?: Buffer;
  /** '0' regular file (default), '5' directory, '2' symlink. */
  type?: string;
}

function tarHeader(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000755\0', 100, 'latin1');
  block.write('0001750\0', 108, 'latin1');
  block.write('0001750\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write('        ', 148, 'latin1'); // checksum field counts as spaces
  block.write(type, 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(tarHeader(entry.name, data.length, entry.type ?? '0'), data);
    parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// ── fixtures ─────────────────────────────────────────────────────────────────

// Larger than one gunzip chunk, so the entry is written across several reads.
const BINARY = Buffer.alloc(150_000, 0);
for (let i = 0; i < BINARY.length; i += 1) BINARY[i] = (i * 31 + 7) % 251;
const SERVER = Buffer.from('this is the 30 MB server binary, which must never be written');

const GOOD = tarGz([
  { name: './', type: '5' },
  { name: './shodh-memory-server', data: SERVER },
  { name: './shodh-tui', data: BINARY },
  { name: './libonnxruntime.so', data: Buffer.from('also not ours to install') },
]);
// Nothing at the archive root is called shodh-tui: a nested file and a symlink
// must both be passed over.
const NO_TUI = tarGz([
  { name: './nested/shodh-tui', data: Buffer.from('wrong place') },
  { name: './shodh-tui', type: '2' },
  { name: './shodh', data: Buffer.from('the cli') },
]);
const TRUNCATED = gzipSync(
  Buffer.concat([tarHeader('./shodh-tui', 4096, '0'), Buffer.alloc(1000, 1)]),
);

const ASSET = 'shodh-memory-linux-x64.tar.gz';

interface FakeRelease {
  archive: Buffer;
  /** Digest to publish; `null` publishes none. Defaults to the true one. */
  digest?: string | null;
  /** Declared size. Defaults to the true one. */
  size?: number;
  assetName?: string;
}

const releases: Record<string, FakeRelease> = {
  'v1.0.0': { archive: GOOD },
  'v1.0.1': { archive: GOOD, digest: 'a'.repeat(64) },
  'v1.0.2': { archive: GOOD, digest: null },
  'v1.0.3': { archive: NO_TUI },
  'v1.0.4': { archive: TRUNCATED },
  'v1.0.5': { archive: GOOD, assetName: 'shodh-memory-windows-x64.zip' },
  'v1.0.6': { archive: GOOD, size: 100 },
};

let downloads = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const release = /^\/releases\/tags\/(.+)$/.exec(url.pathname);
  if (release) {
    const tag = decodeURIComponent(release[1] ?? '');
    const found = releases[tag];
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Not Found' }));
    }
    const digest = found.digest === undefined ? sha256(found.archive) : found.digest;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        tag_name: tag,
        assets: [
          { name: 'unrelated.txt', size: 3, browser_download_url: `${base}/download/none` },
          {
            name: found.assetName ?? ASSET,
            size: found.size ?? found.archive.length,
            ...(digest === null ? {} : { digest: `sha256:${digest}` }),
            browser_download_url: `${base}/download/${tag}`,
          },
        ],
      }),
    );
  }
  const download = /^\/download\/(.+)$/.exec(url.pathname);
  const found = download ? releases[download[1] ?? ''] : undefined;
  if (found) {
    downloads += 1;
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    return res.end(found.archive);
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const root = await mkdtemp(join(tmpdir(), 'shodh-tui-install-'));

/** Run an install expected to fail; return its message. */
async function failure(name: string): Promise<string> {
  try {
    await installTui({ root, tag: tag(name), asset: ASSET, apiBase: base });
  } catch (error) {
    assert.ok(error instanceof TuiInstallError, `${name}: a TuiInstallError`);
    return error.message;
  }
  assert.fail(`${name}: install should have failed`);
}

/** Files left under one tag directory. */
async function leftovers(tag: string): Promise<string[]> {
  return readdir(join(root, tag)).catch(() => []);
}

// ── checks ───────────────────────────────────────────────────────────────────

console.log('\n[1] platform → release asset');
check('linux x64', releaseAsset('linux', 'x64') === 'shodh-memory-linux-x64.tar.gz');
check('linux arm64', releaseAsset('linux', 'arm64') === 'shodh-memory-linux-arm64.tar.gz');
check('macOS x64', releaseAsset('darwin', 'x64') === 'shodh-memory-macos-x64.tar.gz');
check('macOS arm64', releaseAsset('darwin', 'arm64') === 'shodh-memory-macos-arm64.tar.gz');
check('Windows has no asset we unpack', releaseAsset('win32', 'x64') === undefined);
check('unknown CPU has no asset', releaseAsset('linux', 'riscv64') === undefined);

console.log('\n[2] version → tag');
check('bare version gains a v', normalizeTag('0.2.0') === 'v0.2.0');
check('tag passes through', normalizeTag(' v0.2.0 ') === 'v0.2.0');
check('prerelease accepted', normalizeTag('0.3.0-rc.1') === 'v0.3.0-rc.1');
check('path traversal rejected', normalizeTag('../../etc') === undefined);
check('a slash is rejected', normalizeTag('v1.0.0/x') === undefined);
check('"latest" rejected', normalizeTag('latest') === undefined);
check(
  'non-strings rejected',
  normalizeTag(undefined) === undefined && normalizeTag(2) === undefined,
);

console.log('\n[3] install root');
check(
  'explicit home wins',
  tuiRoot('/srv/dsh') === join('/srv/dsh', 'plugins', 'shodh-memory', 'tui'),
);
const savedHome = process.env.DSH_HOME;
process.env.DSH_HOME = '/env/dsh';
check('falls back to $DSH_HOME', tuiRoot() === join('/env/dsh', 'plugins', 'shodh-memory', 'tui'));
process.env.DSH_HOME = '  ';
check(
  'blank $DSH_HOME is ignored',
  tuiRoot().endsWith(join('.dsh', 'plugins', 'shodh-memory', 'tui')),
);
if (savedHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedHome;

console.log('\n[4] a verified install');
check('nothing installed at first', (await listInstalled(root)).length === 0);
const result = await installTui({ root, tag: tag('v1.0.0'), asset: ASSET, apiBase: base });
check('reports the tag', result.tag === 'v1.0.0');
check('reports the published digest', result.sha256 === sha256(GOOD));
check('installs to <root>/<tag>/shodh-tui', result.path === installedPath(root, tag('v1.0.0')));
check('binary bytes are exact', (await readFile(result.path)).equals(BINARY));
check('binary is executable', ((await stat(result.path)).mode & 0o777) === 0o755);
check(
  'only shodh-tui is on disk — no server, no archive',
  (await leftovers('v1.0.0')).join() === 'shodh-tui',
);
check('listed as installed', (await listInstalled(root)).join() === 'v1.0.0');

console.log('\n[5] refusals install nothing');
const mismatch = await failure('v1.0.1');
check('digest mismatch is refused', mismatch.includes('sha256 mismatch'));
check('mismatch leaves nothing behind', (await leftovers('v1.0.1')).length === 0);

const before = downloads;
const noDigest = await failure('v1.0.2');
check('a release without a digest is refused', noDigest.includes('publishes no sha256'));
check('…before anything is downloaded', downloads === before);

const noTui = await failure('v1.0.3');
check('an archive without shodh-tui is refused', noTui.includes('contains no shodh-tui'));
check('nested and symlink entries were not taken', (await leftovers('v1.0.3')).length === 0);

const truncated = await failure('v1.0.4');
check('a truncated archive is refused', truncated.length > 0);
check('truncation leaves nothing behind', (await leftovers('v1.0.4')).length === 0);

check('a release missing our asset says so', (await failure('v1.0.5')).includes(`no ${ASSET}`));
check('an oversized download is stopped', (await failure('v1.0.6')).includes('larger than'));
check('an unknown tag says so', (await failure('v9.9.9')).includes('no release tagged v9.9.9'));
check('failed installs are not listed', (await listInstalled(root)).join() === 'v1.0.0');

console.log('\n[6] cancellation');
const cancelled = new AbortController();
cancelled.abort();
try {
  await installTui({
    root,
    tag: tag('v1.0.0'),
    asset: ASSET,
    apiBase: base,
    signal: cancelled.signal,
  });
  assert.fail('a pre-aborted install should fail');
} catch (error) {
  check('an aborted install reports cancellation', (error as Error).message.includes('cancelled'));
}
check('…and keeps the earlier install', (await readFile(result.path)).equals(BINARY));

console.log('\n[7] several installs sort newest first');
releases['v1.2.0'] = { archive: GOOD };
releases['v1.10.0'] = { archive: GOOD };
releases['v1.10.0-rc.1'] = { archive: GOOD };
for (const version of ['v1.2.0', 'v1.10.0', 'v1.10.0-rc.1']) {
  await installTui({ root, tag: tag(version), asset: ASSET, apiBase: base });
}
check(
  'numeric order, release above its prerelease',
  (await listInstalled(root)).join() === 'v1.10.0,v1.10.0-rc.1,v1.2.0,v1.0.0',
);

console.log(`\n${passed} checks passed.\n`);

await rm(root, { recursive: true, force: true });
server.close();
process.exit(0);
