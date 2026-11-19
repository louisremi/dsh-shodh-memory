/**
 * Tests for `/shodh tui`.
 *
 * The verb is driven directly, against a fake of the two DSH services it uses
 * (`terminalController`, `sandboxPolicy`) and a fake sidebar terminal that
 * behaves like the real one where it matters: its revision advances on output,
 * `changed` wakes on it, reads fail once it is closed, and `close` refuses once
 * the person has taken the terminal over.
 *
 * What is pinned is what reaches the terminal — the launch request and the one
 * line typed into the shell — and the text of every refusal.
 *
 * Run: `pnpm test`
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShodhClient } from '../src/client.js';
import { normalizeConfig } from '../src/config.js';
import { createTui, MISSING_BINARY, TUI_HELP, TUI_TITLE } from '../src/tui.js';
import { launchLine, shellQuote } from '../src/tui-terminal.js';
import type {
  AgentRef,
  AgentTerminalLike,
  AgentTerminalRequestLike,
  CommandResult,
  ShodhContext,
} from '../src/types.js';

let passed = 0;
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── fake sidebar terminal ────────────────────────────────────────────────────

class FakeTerminal implements AgentTerminalLike {
  info: { state: string; control: string; exitCode: number | null; error?: string } = {
    state: 'running',
    control: 'agent',
    exitCode: null,
  };
  revision = 0;
  screen = '';
  writes: string[] = [];
  closed = false;
  /** What happens when input arrives; set per scenario. */
  onWrite: (data: string) => void = () => {};
  private waiters = new Set<() => void>();

  /** Print something, as a shell or program would. */
  output(text: string): void {
    this.screen += text;
    this.bump();
  }
  /** End the top-level process. */
  exit(code: number): void {
    this.info = { ...this.info, state: 'exited', exitCode: code };
    this.bump();
  }
  private bump(): void {
    this.revision += 1;
    for (const wake of [...this.waiters]) wake();
  }

  async changed(after: number, signal: AbortSignal): Promise<number> {
    while (this.revision <= after) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', wake);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    return this.revision;
  }
  async write(data: string): Promise<void> {
    if (this.info.state !== 'running') throw new Error('The terminal is not running');
    this.writes.push(data);
    this.onWrite(data);
  }
  async drain(): Promise<void> {}
  read(): { text: string } {
    if (this.closed) throw new Error('unavailable');
    return { text: this.screen };
  }
  async close(): Promise<void> {
    if (this.info.control !== 'agent') throw new Error('The user has taken over this terminal');
    this.closed = true;
  }
}

// ── fake host ────────────────────────────────────────────────────────────────

interface Opened {
  agent: unknown;
  request: AgentTerminalRequestLike;
  terminal: FakeTerminal;
}

interface HostOptions {
  /** Shape each new terminal before it is returned. */
  prepare?: (terminal: FakeTerminal) => void;
  /** Make `openForAgent` reject. */
  openError?: unknown;
  /** Leave the terminal services out, as a headless profile does. */
  headless?: boolean;
  /** DSH home reported by the host. */
  home?: string;
}

function host(options: HostOptions = {}) {
  const opened: Opened[] = [];
  const services: Record<string, unknown> = {
    profileContext: { home: options.home ?? emptyHome },
  };
  if (!options.headless) {
    services.terminalController = {
      async openForAgent(agent: unknown, request: AgentTerminalRequestLike) {
        if (options.openError) throw options.openError;
        const terminal = new FakeTerminal();
        (options.prepare ?? promptThenRun)(terminal);
        opened.push({ agent, request, terminal });
        return terminal;
      },
    };
    services.sandboxPolicy = {
      resolve: (request: { session?: unknown }) => ({
        mode: 'workspace-write',
        for: request.session,
      }),
    };
  }
  const ctx = { get: (name: string) => services[name] } as unknown as ShodhContext;
  return { ctx, opened };
}

/** A well-behaved shell: prints a prompt, then runs what is typed. */
function promptThenRun(terminal: FakeTerminal): void {
  setTimeout(() => terminal.output('user@host:~$ '), 5);
  terminal.onWrite = () => terminal.output('\n[shodh dashboard]');
}

/** An agent whose execution provider knows exactly these executables. */
function agent(id: string, executables: string[] = []): AgentRef {
  return {
    id,
    session: { id },
    ctx: {
      get: (name: string) =>
        name === 'subprocess'
          ? {
              async resolveExecutable(command: string) {
                if (executables.includes(command)) return command;
                throw new Error(`not found: ${command}`);
              },
            }
          : undefined,
    },
  };
}

const FAST = { startupQuietMs: 20, startupTimeoutMs: 300, launchWatchMs: 60 };
const BIN = '/opt/shodh/shodh-tui';

function tui(
  ctxHost: ReturnType<typeof host>,
  overrides: {
    tui?: Record<string, unknown>;
    health?: Record<string, unknown> | undefined;
    apiKey?: string;
    releaseApi?: string;
    timings?: Partial<typeof FAST>;
  } = {},
) {
  const cfg = normalizeConfig({
    baseUrl: 'http://shodh.test:3030/',
    tui: { path: BIN, ...overrides.tui },
  });
  const client = {
    soft: async () => ('health' in overrides ? overrides.health : { status: 'ok' }),
  } as unknown as ShodhClient;
  return createTui(
    ctxHost.ctx,
    {
      client,
      cfg,
      apiKey: 'apiKey' in overrides ? overrides.apiKey : 'key-123',
      resolveUserId: () => 'dsh-my-project',
    },
    { releaseApi: overrides.releaseApi, timings: { ...FAST, ...overrides.timings } },
  );
}

const emptyHome = await mkdtemp(join(tmpdir(), 'shodh-tui-home-'));
const stockedHome = await mkdtemp(join(tmpdir(), 'shodh-tui-home-'));
const stockedRoot = join(stockedHome, 'plugins', 'shodh-memory', 'tui');
for (const tag of ['v0.1.90', 'v0.2.0', 'v0.3.0']) {
  await mkdir(join(stockedRoot, tag), { recursive: true });
  await writeFile(join(stockedRoot, tag, 'shodh-tui'), '#!/bin/sh\n');
  await chmod(join(stockedRoot, tag, 'shodh-tui'), 0o755);
}
const managed = (tag: string) => join(stockedRoot, tag, 'shodh-tui');

// ── checks ───────────────────────────────────────────────────────────────────

console.log('\n[1] opening the dashboard');
{
  const h = host();
  const t = tui(h);
  const me = agent('sess-1', [BIN]);
  const result = await t.run({ agent: me, signal: new AbortController().signal }, '');
  check('succeeds', result.kind === 'success');
  check('one terminal opened', h.opened.length === 1);
  const { request, terminal, agent: owner } = h.opened[0] as Opened;
  check('for the invoking agent', owner === me);
  check('titled for the tab', request.title === TUI_TITLE && TUI_TITLE === 'Shodh memory');
  check(
    'server URL in the environment',
    request.env?.SHODH_SERVER_URL === 'http://shodh.test:3030',
  );
  check('API key in the environment', request.env?.SHODH_API_KEY === 'key-123');
  check('configured grid', request.cols === 120 && request.rows === 36);
  check(
    'runs under the session sandbox policy',
    (request.policy as { for?: unknown }).for === me.session,
  );
  check('no shell preference', request.preferredShells.length === 0);
  check(
    'starts in the plugin state directory, not the workspace',
    request.cwd === join(emptyHome, 'plugins', 'shodh-memory', 'tui'),
  );
  check('exactly one line typed', terminal.writes.length === 1);
  check('the line execs the binary', terminal.writes[0] === ` exec '${BIN}' || exit 127\r`);
  check('the key is never typed', !terminal.writes.join('').includes('key-123'));
  check('result names the panel', result.text.includes('right panel'));
  check('result names the profile to pick', result.text.includes('"dsh-my-project"'));

  const again = await t.run({ agent: me }, '');
  check('a second run reports it is already open', again.text.includes('already open'));
  check('…and opens nothing', h.opened.length === 1);

  // The person quits the TUI; the next run starts a fresh one.
  terminal.exit(0);
  const reopened = await t.run({ agent: me }, '');
  check('after it exits, a run opens a new terminal', reopened.kind === 'success');
  check('…a second one', h.opened.length === 2);
  check('…and releases the ended one', terminal.closed);

  // The person closes the tab: the screen is released while the state lingers.
  (h.opened[1] as Opened).terminal.closed = true;
  await t.run({ agent: me }, '');
  check('after the tab is closed, a run opens a new terminal', h.opened.length === 3);
}

console.log('\n[2] one terminal per session');
{
  const h = host();
  const t = tui(h);
  const me = agent('sess-2', [BIN]);
  const [a, b] = await Promise.all([t.run({ agent: me }, ''), t.run({ agent: me }, '')]);
  check('two simultaneous runs share one terminal', h.opened.length === 1);
  check('both succeed', a.kind === 'success' && b.kind === 'success');
  await t.run({ agent: agent('sess-3', [BIN]) }, '');
  check('another session gets its own', h.opened.length === 2);
}

console.log('\n[3] shells that behave differently');
{
  const silent = host({ prepare: () => {} });
  const result = await tui(silent, { timings: { startupTimeoutMs: 60 } }).run(
    { agent: agent('s', [BIN]) },
    '',
  );
  check('a shell that prints nothing is typed into after the timeout', result.kind === 'success');
  check('…once', (silent.opened[0] as Opened).terminal.writes.length === 1);

  const noisy = host({
    prepare: (terminal) => {
      let n = 0;
      const timer = setInterval(() => {
        terminal.output('.');
        n += 1;
        if (n === 6) clearInterval(timer);
      }, 8);
      terminal.onWrite = () => terminal.output('[dashboard]');
    },
  });
  await tui(noisy).run({ agent: agent('s', [BIN]) }, '');
  const noisyTerminal = (noisy.opened[0] as Opened).terminal;
  check('typing waits for startup output to stop', noisyTerminal.screen.startsWith('......'));

  // A terminal whose `changed` resolves when its wait is aborted, without any
  // output. Counting that as output would restart the quiet timer forever.
  const lax = host({
    prepare: (terminal) => {
      terminal.screen = '$ ';
      terminal.changed = (_after, signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener('abort', () => resolve(terminal.revision), { once: true });
        });
    },
  });
  const started = Date.now();
  await tui(lax, {
    timings: { startupQuietMs: 20, startupTimeoutMs: 2000, launchWatchMs: 20 },
  }).run({ agent: agent('s', [BIN]) }, '');
  check(
    'a wait that ends without output does not reset the quiet timer',
    Date.now() - started < 1000,
  );

  const keyless = host();
  await tui(keyless, { apiKey: undefined }).run({ agent: agent('s', [BIN]) }, '');
  check(
    'without a key, none is passed',
    !('SHODH_API_KEY' in ((keyless.opened[0] as Opened).request.env ?? {})),
  );
}

console.log('\n[4] quoting');
check('plain path', shellQuote('/a/b') === `'/a/b'`);
check('spaces survive', shellQuote('/a b/c') === `'/a b/c'`);
check('a single quote is escaped', shellQuote(`/it's`) === `'/it'\\''s'`);
check('nothing is expanded', shellQuote('$(rm -rf ~)`x`') === `'$(rm -rf ~)\`x\`'`);
{
  const odd = `/opt/it's here/shodh-tui`;
  const h = host();
  await tui(h, { tui: { path: odd } }).run({ agent: agent('s', [odd]) }, '');
  check(
    'an awkward path is typed quoted',
    (h.opened[0] as Opened).terminal.writes[0] ===
      ` exec '/opt/it'\\''s here/shodh-tui' || exit 127\r`,
  );
}

check(
  'a failed exec ends the shell instead of leaving a prompt',
  launchLine('/a/b') === ` exec '/a/b' || exit 127`,
);

console.log('\n[5] which binary runs');
{
  const pick = async (
    overrides: Parameters<typeof tui>[1],
    executables: string[],
  ): Promise<string | CommandResult> => {
    const h = host({ home: stockedHome });
    const result = await tui(h, overrides).run({ agent: agent('s', executables) }, '');
    const typed = h.opened[0]?.terminal.writes[0];
    return typed ? typed.slice(` exec '`.length, -`' || exit 127\r`.length) : result;
  };
  const all = [managed('v0.1.90'), managed('v0.2.0'), managed('v0.3.0'), 'shodh-tui', BIN];

  check('tui.path wins over everything', (await pick({}, all)) === BIN);
  check(
    'no path: the configured version',
    (await pick({ tui: { path: '', version: '0.1.90' } }, all)) === managed('v0.1.90'),
  );
  check(
    'no path, no version: the one matching the server',
    (await pick({ tui: { path: '' }, health: { version: '0.2.0' } }, all)) === managed('v0.2.0'),
  );
  check(
    'server unreachable: the newest installed',
    (await pick({ tui: { path: '' }, health: undefined }, all)) === managed('v0.3.0'),
  );
  check(
    'server on a version we lack: the newest installed',
    (await pick({ tui: { path: '' }, health: { version: '9.9.9' } }, all)) === managed('v0.3.0'),
  );

  const opened = async (overrides: Parameters<typeof tui>[1]) =>
    tui(host({ home: stockedHome }), overrides).run({ agent: agent('s', all) }, '');
  const behind = await opened({ tui: { path: '' }, health: { version: '9.9.9' } });
  check(
    'a server newer than every install: opened, with a hint to install its version',
    behind.kind === 'success' &&
      behind.text.includes('shodh-tui v0.3.0, but the server runs v9.9.9') &&
      behind.text.includes('/shodh tui install'),
  );
  const matched = await opened({ tui: { path: '' }, health: { version: '0.2.0' } });
  check('a matching install: no hint', !matched.text.includes('server runs'));
  const unknown = await opened({ tui: { path: '' }, health: undefined });
  check('server unreachable: no hint', !unknown.text.includes('server runs'));
  const pinned = await opened({
    tui: { path: '', version: '0.1.90' },
    health: { version: '0.2.0' },
  });
  check('a configured version: no hint', !pinned.text.includes('server runs'));

  const h = host();
  await tui(h, { tui: { path: '' } }).run({ agent: agent('s', ['shodh-tui']) }, '');
  check(
    'nothing installed: shodh-tui from PATH',
    (h.opened[0] as Opened).terminal.writes[0] === ` exec 'shodh-tui' || exit 127\r`,
  );

  const broken = (await pick(
    {},
    all.filter((p) => p !== BIN),
  )) as CommandResult;
  check('a tui.path that is not executable is an error', broken.kind === 'error');
  check('…naming the path', broken.text.includes(BIN));
  const relative = (await pick({ tui: { path: 'bin/shodh-tui' } }, all)) as CommandResult;
  check('a relative tui.path is an error', relative.text.includes('absolute path'));
}

console.log('\n[6] refusals');
{
  const none = host();
  const missing = await tui(none, { tui: { path: '' } }).run({ agent: agent('s') }, '');
  check('no binary anywhere is an error', missing.kind === 'error');
  check(
    '…whose first line is the one the card matches',
    missing.text.split('\n')[0] === MISSING_BINARY &&
      MISSING_BINARY === 'No shodh-tui binary found.',
  );
  check('…that names the install command', missing.text.includes('/shodh tui install'));
  check('…and the override', missing.text.includes('tui.path'));
  check('…and opens no terminal', none.opened.length === 0);

  const headless = await tui(host({ headless: true })).run({ agent: agent('s', [BIN]) }, '');
  check('without terminal services it is an error', headless.kind === 'error');
  check('…that says where it works', headless.text.includes('Web and Desktop'));

  const noAgent = await tui(host()).run({}, '');
  check('without an agent it is an error', noAgent.kind === 'error');

  const off = host();
  const disabled = await tui(off, { tui: { enabled: false } }).run(
    { agent: agent('s', [BIN]) },
    '',
  );
  check('tui.enabled false is an error', disabled.text.includes('tui.enabled is false'));
  check('…and opens no terminal', off.opened.length === 0);

  const full = await tui(
    host({ openError: Object.assign(new Error('limit'), { code: 'terminal/limit-reached' }) }),
  ).run({ agent: agent('s', [BIN]) }, '');
  check('the terminal limit asks to close a tab', full.text.includes('Close a terminal tab'));

  const failed = await tui(host({ openError: new Error('pty allocation failed') })).run(
    { agent: agent('s', [BIN]) },
    '',
  );
  check('another open failure carries its reason', failed.text.includes('pty allocation failed'));

  const usage = await tui(host()).run({ agent: agent('s', [BIN]) }, 'bogus');
  check('an unknown sub-verb shows usage', usage.kind === 'error' && usage.text.includes('Usage'));
  check(
    '…in the words of /shodh help',
    TUI_HELP.every((line) => usage.text.includes(line)),
  );
}

console.log('\n[7] a binary that cannot start');
{
  const loader = "shodh-tui: /lib/libc.so.6: version `GLIBC_2.39' not found";
  const h = host({
    prepare: (terminal) => {
      setTimeout(() => terminal.output('$ '), 5);
      terminal.onWrite = () => {
        terminal.output(`\n${loader}\n`);
        terminal.exit(1);
      };
    },
  });
  const t = tui(h);
  const me = agent('s', [BIN]);
  const result = await t.run({ agent: me }, '');
  check('an immediate exit is an error', result.kind === 'error');
  check('…carrying the loader message', result.text.includes(loader));
  check('…and the path that was run', result.text.includes(BIN));
  check('the dead terminal is closed', (h.opened[0] as Opened).terminal.closed);
  await t.run({ agent: me }, '');
  check('…and not remembered as open', h.opened.length === 2);

  const execError = `bash: ${BIN}: cannot execute binary file: Exec format error`;
  const wrongArch = host({
    prepare: (terminal) => {
      setTimeout(() => terminal.output('$ '), 5);
      terminal.onWrite = (data) => {
        terminal.output(`${data.trim()}\n${execError}\n`);
        // What `|| exit 127` does once `exec` has failed.
        if (data.includes('|| exit 127')) terminal.exit(127);
      };
    },
  });
  const refused = await tui(wrongArch).run({ agent: agent('s', [BIN]) }, '');
  check('a failed exec is an error, not an open prompt', refused.kind === 'error');
  check('…carrying the shell message', refused.text.includes('Exec format error'));

  const dead = host({
    prepare: (terminal) => {
      setTimeout(() => terminal.exit(1), 5);
    },
  });
  const early = await tui(dead).run({ agent: agent('s', [BIN]) }, '');
  check('a shell that dies at startup is an error', early.text.includes('exited at startup'));
  check('…with nothing typed', (dead.opened[0] as Opened).terminal.writes.length === 0);
}

console.log('\n[8] cancellation');
{
  const h = host({ prepare: () => {} });
  const abort = new AbortController();
  const pending = tui(h, { timings: { startupTimeoutMs: 5000 } }).run(
    { agent: agent('s', [BIN]), signal: abort.signal },
    '',
  );
  await sleep(20);
  abort.abort();
  const result = await pending;
  check('aborting while the shell starts is an error', result.kind === 'error');
  check('…and closes the terminal', (h.opened[0] as Opened).terminal.closed);
}

console.log('\n[9] teardown');
{
  const h = host();
  const t = tui(h);
  await t.run({ agent: agent('mine', [BIN]) }, '');
  await t.run({ agent: agent('theirs', [BIN]) }, '');
  const [mine, theirs] = h.opened.map((o) => o.terminal) as [FakeTerminal, FakeTerminal];
  theirs.info = { ...theirs.info, control: 'user' }; // the person typed into it
  t.dispose();
  await sleep(5);
  check('a terminal the plugin controls is closed', mine.closed);
  check('a terminal the person took over is left open', !theirs.closed);
}
{
  const h = host();
  const t = tui(h);
  const pending = t.run({ agent: agent('late', [BIN]) }, '');
  await sleep(10); // the terminal is open, the launch watch still running
  t.dispose();
  const late = await pending;
  check('a launch that ends after teardown is an error', late.kind === 'error');
  check('…and closes its terminal', (h.opened[0] as Opened).terminal.closed);
}

console.log('\n[10] /shodh tui install');
{
  // A stand-in for the GitHub API that knows no releases at all.
  const asked: string[] = [];
  const github = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
  const releaseApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  const supported = ['linux', 'darwin'].includes(process.platform);

  const h = host();
  const fromServer = await tui(h, { releaseApi, health: { version: '0.2.0' } }).run({}, 'install');
  if (supported) {
    check('defaults to the server version', asked.includes('/releases/tags/v0.2.0'));
    check('a missing release is an error', fromServer.text.includes('no release tagged v0.2.0'));
  }
  check('a failed install is an error', fromServer.kind === 'error');
  check('install opens no terminal', h.opened.length === 0);

  asked.length = 0;
  await tui(host(), { releaseApi, tui: { version: 'v0.1.91' }, health: { version: '0.2.0' } }).run(
    {},
    'install',
  );
  if (supported)
    check('tui.version beats the server version', asked[0] === '/releases/tags/v0.1.91');

  asked.length = 0;
  await tui(host(), { releaseApi }).run({}, 'install 0.1.80');
  if (supported) check('an explicit version beats both', asked[0] === '/releases/tags/v0.1.80');

  asked.length = 0;
  const unknown = await tui(host(), { releaseApi, health: undefined }).run({}, 'install');
  if (supported) {
    check('no server and no version asks for one', unknown.text.includes('/shodh tui install v'));
    check('…without asking GitHub', asked.length === 0);
  }

  const bad = await tui(host(), { releaseApi }).run({}, 'install ../../etc');
  if (supported) check('a malformed version shows usage', bad.text.startsWith('Usage:'));
  check('a malformed version is an error', bad.kind === 'error');

  asked.length = 0;
  const present = await tui(host({ home: stockedHome }), { releaseApi }).run({}, 'install v0.2.0');
  if (supported) {
    check('an installed version is not downloaded again', asked.length === 0);
    check('…and its path is reported', present.text.includes(managed('v0.2.0')));
  }

  const disabled = await tui(host(), { releaseApi, tui: { enabled: false } }).run({}, 'install');
  check('install respects tui.enabled', disabled.text.includes('tui.enabled is false'));

  check(
    'failed installs left nothing in the plugin state directory',
    (await readdir(join(emptyHome, 'plugins', 'shodh-memory', 'tui')).catch(() => [])).length === 0,
  );
  github.close();
}

console.log('\n[11] /shodh tui clean');
{
  const home = await mkdtemp(join(tmpdir(), 'shodh-tui-home-'));
  const root = join(home, 'plugins', 'shodh-memory', 'tui');
  const stock = async (tags: string[]) => {
    for (const tag of tags) {
      await mkdir(join(root, tag), { recursive: true });
      await writeFile(join(root, tag, 'shodh-tui'), '#!/bin/sh\n');
    }
  };
  const left = async () => (await readdir(root).catch(() => [])).sort().join();
  const clean = (argument: string, health?: Record<string, unknown>) =>
    tui(host({ home }), { tui: { path: '' }, health }).run({}, `clean${argument}`);

  await stock(['v0.1.90', 'v0.2.0', 'v0.3.0']);
  const some = await clean('', { version: '0.2.0' });
  check('keeps the version /shodh tui would run', (await left()) === 'v0.2.0');
  check(
    '…and says what it removed and kept',
    some.kind === 'success' &&
      some.text.includes('v0.3.0, v0.1.90') &&
      some.text.includes('Kept v0.2.0'),
  );
  const none = await clean('', { version: '0.2.0' });
  check(
    'nothing else to remove is a success',
    none.kind === 'success' && none.text.includes('No shodh-tui download'),
  );

  await stock(['v0.3.0']);
  await clean('', undefined);
  check('server unreachable: keeps the newest', (await left()) === 'v0.3.0');

  const all = await clean(' all');
  check('`all` removes every install', (await left()) === '' && all.text.includes('v0.3.0'));
  check('…and keeps none', !all.text.includes('Kept'));

  const bad = await clean(' everything');
  check('an unknown argument shows usage', bad.kind === 'error' && bad.text.startsWith('Usage:'));
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed.\n`);

await rm(emptyHome, { recursive: true, force: true });
await rm(stockedHome, { recursive: true, force: true });
process.exit(0);
