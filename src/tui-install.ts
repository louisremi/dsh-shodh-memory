/**
 * Managed install of upstream's `shodh-tui` binary.
 *
 * The TUI is not ours and is not vendored: it ships inside every shodh-memory
 * GitHub release next to the server. This module fetches one release archive,
 * checks it against the sha256 GitHub publishes for that asset, and keeps a
 * single file out of it — `shodh-tui`. The server binary and the ONNX runtime
 * in the same archive are never written to disk.
 *
 * It is only ever reached from `/shodh tui install`. Nothing here runs on
 * plugin start, on a turn, or implicitly on `/shodh tui`: the plugin's promise
 * that it talks to nothing but the configured shodh server holds until a person
 * types that command.
 *
 * Node built-ins only — the plugin keeps zero runtime dependencies.
 *
 * @module tui-install
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

/** Upstream repository, as the GitHub REST API addresses it. */
export const DEFAULT_RELEASE_API = 'https://api.github.com/repos/varun29ankuS/shodh-memory';

/** The file kept from the release archive, and its name once installed. */
export const TUI_BINARY = 'shodh-tui';

/** Release archives are ~35 MB; anything far past that is not one. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** The binary is ~3 MB; a tar entry claiming far more is not it. */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
/** Overall budget for release metadata plus the download. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const TAR_BLOCK = 512;

/**
 * A release tag such as `v0.2.0`, as produced by {@link normalizeTag}.
 *
 * Tags become a directory name and a URL path segment, so only validated
 * strings may carry this type: nothing else can be passed where one is needed.
 */
export type ReleaseTag = string & { readonly __brand: 'ReleaseTag' };

/** A failure with a message written for the person who ran the command. */
export class TuiInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TuiInstallError';
  }
}

/**
 * Name of the release archive holding a `shodh-tui` for this machine.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the asset file name, or `undefined` when upstream ships none we can
 *   unpack (Windows releases are zip archives; see the README).
 */
export function releaseAsset(platform: string, arch: string): string | undefined {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : undefined;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  return os && cpu ? `shodh-memory-${os}-${cpu}.tar.gz` : undefined;
}

/**
 * Turn a version as people and servers write it into a release tag.
 * @param version - `0.2.0`, `v0.2.0`, or anything else.
 * @returns `v0.2.0`, or `undefined` for input that is not a version. The result
 *   is used as a directory name and a URL segment, so nothing else gets through.
 */
export function normalizeTag(version: unknown): ReleaseTag | undefined {
  if (typeof version !== 'string') return undefined;
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(version.trim());
  return match ? (`v${match[1]}` as ReleaseTag) : undefined;
}

/**
 * Directory holding managed installs, one sub-directory per release tag.
 * @param home - the DSH home, when the host told us; else `$DSH_HOME`, else `~/.dsh`.
 * @returns the absolute directory. It may not exist yet.
 */
export function tuiRoot(home?: string): string {
  const env = process.env.DSH_HOME;
  const base =
    home && home.length > 0 ? home : env && env.trim().length > 0 ? env : join(homedir(), '.dsh');
  return join(base, 'plugins', 'shodh-memory', 'tui');
}

/**
 * Where the binary for one release tag lives.
 * @param root - {@link tuiRoot}.
 * @param tag - the release tag.
 * @returns the absolute file path.
 */
export function installedPath(root: string, tag: ReleaseTag): string {
  return join(root, tag, TUI_BINARY);
}

/**
 * Release tags with an installed binary, newest first.
 * @param root - {@link tuiRoot}.
 * @returns the tags; empty when nothing is installed.
 */
export async function listInstalled(root: string): Promise<ReleaseTag[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const tags: ReleaseTag[] = [];
  for (const name of names) {
    const tag = normalizeTag(name);
    // Only directories already named exactly like a tag (`v0.2.0`, not `0.2.0`).
    if (tag !== name) continue;
    try {
      if ((await stat(installedPath(root, tag))).isFile()) tags.push(tag);
    } catch {
      /* a tag directory without a binary is a failed or removed install */
    }
  }
  return tags.sort(compareTagsDescending);
}

/** Order release tags newest first; a prerelease sorts below its release. */
function compareTagsDescending(a: ReleaseTag, b: ReleaseTag): number {
  const parse = (tag: string) => {
    const [core = '', pre] = tag.slice(1).split('-', 2);
    return { parts: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (y.parts[i] ?? 0) - (x.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return -1;
  if (y.pre === undefined) return 1;
  return x.pre < y.pre ? 1 : -1;
}

/** Input to {@link installTui}. */
export interface InstallOptions {
  /** {@link tuiRoot}. */
  root: string;
  /** The release to install. */
  tag: ReleaseTag;
  /** An asset name from {@link releaseAsset}. */
  asset: string;
  /** Repository API root; tests point this at a local server. */
  apiBase?: string;
  /** Cancels the download. */
  signal?: AbortSignal;
}

/** What {@link installTui} did. */
export interface InstallResult {
  tag: ReleaseTag;
  /** Absolute path of the installed binary. */
  path: string;
  /** Hex sha256 of the verified archive. */
  sha256: string;
  asset: string;
}

/**
 * Download one release archive, verify it, and install `shodh-tui` from it.
 *
 * The archive is hashed while it streams to a temporary file and is unpacked
 * only once the hash matches, so unverified bytes are never executed or even
 * decompressed. The binary lands under a temporary name and is renamed into
 * place, so a concurrent `/shodh tui` sees the old file or the new one.
 *
 * @param options - release, platform asset, and destination.
 * @returns the installed path and the verified digest.
 * @throws TuiInstallError with a message fit to show as the command result.
 */
export async function installTui(options: InstallOptions): Promise<InstallResult> {
  const { root, tag, asset } = options;
  const apiBase = (options.apiBase ?? DEFAULT_RELEASE_API).replace(/\/+$/, '');
  const deadline = linkedSignal(options.signal, INSTALL_TIMEOUT_MS);

  const dir = join(root, tag);
  const suffix = randomBytes(6).toString('hex');
  const archivePath = join(dir, `.download-${suffix}`);
  const partPath = join(dir, `.${TUI_BINARY}-${suffix}`);
  const finalPath = installedPath(root, tag);

  try {
    const release = await findAsset(apiBase, tag, asset, deadline.signal);
    await mkdir(dir, { recursive: true });

    const sha256 = await download(release.url, archivePath, release.size, deadline.signal);
    if (sha256 !== release.sha256) {
      throw new TuiInstallError(
        `sha256 mismatch for ${asset}: GitHub lists ${release.sha256}, the download is ${sha256}. Nothing was installed.`,
      );
    }

    await extractBinary(archivePath, partPath);
    // `open(…, mode)` is filtered through the umask; the binary must be runnable.
    await chmod(partPath, 0o755);
    await rename(partPath, finalPath);
    return { tag, path: finalPath, sha256, asset };
  } catch (error) {
    if (error instanceof TuiInstallError) throw error;
    if (deadline.signal.aborted) {
      throw new TuiInstallError(
        options.signal?.aborted ? 'The install was cancelled.' : 'The download timed out.',
      );
    }
    throw new TuiInstallError(errorMessage(error));
  } finally {
    deadline.dispose();
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(partPath, { force: true }).catch(() => {});
  }
}

/** One release asset as the GitHub API describes it. */
interface ReleaseAsset {
  url: string;
  sha256: string;
  size: number;
}

/**
 * Look one asset up in a release.
 * @param apiBase - repository API root.
 * @param tag - release tag.
 * @param asset - asset file name.
 * @param signal - cancellation.
 * @returns its download URL, published digest, and size.
 */
async function findAsset(
  apiBase: string,
  tag: ReleaseTag,
  asset: string,
  signal: AbortSignal,
): Promise<ReleaseAsset> {
  const response = await fetch(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-shodh-memory' },
    signal,
  });
  if (response.status === 404) {
    throw new TuiInstallError(`shodh-memory has no release tagged ${tag}.`);
  }
  if (!response.ok) {
    throw new TuiInstallError(`GitHub answered HTTP ${response.status} for release ${tag}.`);
  }
  const body = (await response.json()) as { assets?: unknown };
  const assets = Array.isArray(body.assets) ? (body.assets as Record<string, unknown>[]) : [];
  const entry = assets.find((candidate) => candidate?.name === asset);
  if (!entry) throw new TuiInstallError(`Release ${tag} has no ${asset}.`);

  const digest =
    typeof entry.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(entry.digest) : null;
  if (!digest?.[1]) {
    // Older releases predate GitHub's asset digests. Without one there is
    // nothing to verify against, and an unverified binary is not installed.
    throw new TuiInstallError(
      `GitHub publishes no sha256 for ${asset} in ${tag}, so it cannot be verified. Install shodh-tui yourself and set tui.path.`,
    );
  }

  const url = typeof entry.browser_download_url === 'string' ? entry.browser_download_url : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TuiInstallError(`Release ${tag} lists no download URL for ${asset}.`);
  }
  // Plain HTTP is accepted only when the API itself is plain HTTP, which is a
  // local test server and never GitHub.
  const secure = new URL(apiBase).protocol === 'https:';
  if (parsed.protocol !== 'https:' && (secure || parsed.protocol !== 'http:')) {
    throw new TuiInstallError(`Refusing the download URL for ${asset}: ${parsed.protocol}`);
  }

  const size = typeof entry.size === 'number' && entry.size > 0 ? entry.size : MAX_ARCHIVE_BYTES;
  if (size > MAX_ARCHIVE_BYTES) {
    throw new TuiInstallError(
      `${asset} is ${size} bytes, which is not a plausible release archive.`,
    );
  }
  return { url: parsed.href, sha256: digest[1].toLowerCase(), size };
}

/**
 * Stream a URL to a file while hashing it.
 * @param url - what to fetch.
 * @param destination - file to create; must not exist.
 * @param limit - byte ceiling, the asset's declared size.
 * @param signal - cancellation.
 * @returns the hex sha256 of the bytes written.
 */
async function download(
  url: string,
  destination: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-shodh-memory' }, signal });
  if (!response.ok || !response.body) {
    throw new TuiInstallError(`The download answered HTTP ${response.status}.`);
  }
  const hash = createHash('sha256');
  const file = await open(destination, 'wx', 0o600);
  try {
    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new TuiInstallError('The download is larger than the release lists; stopped.');
      }
      hash.update(value);
      await file.write(value);
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

/**
 * Pull the `shodh-tui` entry out of a verified `.tar.gz`.
 *
 * A deliberately small tar reader: it walks headers, skips every entry's data,
 * and writes exactly one regular file whose name is `shodh-tui` at the archive
 * root. No entry name is ever used as a path, so there is nothing to traverse.
 *
 * @param archivePath - the verified archive.
 * @param destination - file to create; must not exist.
 */
async function extractBinary(archivePath: string, destination: string): Promise<void> {
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);

  let header: Buffer = Buffer.alloc(0);
  let remaining = 0; // data bytes left in the current entry
  let padding = 0; // zero fill up to the next 512-byte boundary
  let found = false;
  let out: Awaited<ReturnType<typeof open>> | undefined;

  try {
    for await (const piece of gunzip) {
      const chunk = piece as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length - offset);
          if (out) await out.write(chunk, offset, take);
          remaining -= take;
          offset += take;
          if (remaining === 0 && out) {
            await out.close();
            out = undefined;
            return;
          }
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, chunk.length - offset);
          padding -= take;
          offset += take;
          continue;
        }

        const take = Math.min(TAR_BLOCK - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < TAR_BLOCK) continue;
        const block = header;
        header = Buffer.alloc(0);
        if (block.every((byte) => byte === 0)) continue; // end-of-archive filler

        const size = tarSize(block);
        remaining = size;
        padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
        const type = block[156];
        const regular = type === 0 || type === 0x30; // NUL or '0'
        if (regular && tarName(block) === TUI_BINARY) {
          if (size === 0 || size > MAX_BINARY_BYTES) {
            throw new TuiInstallError(`The archive's ${TUI_BINARY} is ${size} bytes; refusing it.`);
          }
          out = await open(destination, 'wx', 0o700);
          found = true;
        }
      }
    }
  } finally {
    await out?.close().catch(() => {});
    input.destroy();
    gunzip.destroy();
  }
  throw new TuiInstallError(
    !found
      ? `The release archive contains no ${TUI_BINARY}.`
      : `The release archive ends in the middle of ${TUI_BINARY}.`,
  );
}

/** Entry name from a tar header, without a leading `./`. */
function tarName(block: Buffer): string {
  const field = (start: number, end: number) => {
    const raw = block.subarray(start, end);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul < 0 ? raw.length : nul).toString('utf8');
  };
  const prefix = block.subarray(257, 262).toString('latin1') === 'ustar' ? field(345, 500) : '';
  const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
  return name.replace(/^(?:\.\/)+/, '');
}

/** Entry size from a tar header's octal field. */
function tarSize(block: Buffer): number {
  const raw = block.subarray(124, 136);
  // A set high bit means GNU base-256, used only past 8 GiB. Not this archive.
  if (((raw[0] ?? 0) & 0x80) !== 0)
    throw new TuiInstallError('Unsupported tar entry size encoding.');
  const text = raw
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .trim();
  const size = text === '' ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TuiInstallError('The release archive is not a valid tar file.');
  }
  return size;
}

/**
 * One signal that aborts on the caller's signal or after a timeout.
 * (`AbortSignal.any` needs Node 20.3; the plugin supports 18.)
 * @param outer - the caller's signal, if any.
 * @param timeoutMs - delay after which the signal aborts on its own.
 * @returns the linked signal, and `dispose` to release the timer and listener.
 */
export function linkedSignal(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (outer?.aborted) abort();
  else outer?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', abort);
    },
  };
}

/**
 * The message of a thrown value.
 * @param error - anything caught.
 * @returns its `message` for an `Error`, else its string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
