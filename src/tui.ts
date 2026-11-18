/**
 * `/shodh tui` — upstream's terminal dashboard in the right sidebar.
 *
 * shodh-memory ships a ratatui dashboard (`shodh-tui`) that shows what the
 * engine stores, links, and retrieves. This module does not port or wrap it:
 * it runs the upstream binary, unmodified, in one of DSH's own sidebar
 * terminals. DSH already owns the PTY, the screen recovery, and the xterm.js
 * tab, so the whole integration is "open a terminal, start one program in it".
 * Following a new upstream TUI means installing a newer binary.
 *
 * Two services make that possible and both exist only in the Web and Desktop
 * apps: `terminalController` (allocates the sidebar terminal) and
 * `sandboxPolicy` (the session's file-effect policy, which the terminal runs
 * under like any agent terminal). They are looked up when the command runs and
 * are deliberately absent from the plugin's `inject`, so a headless profile
 * keeps recall, capture and the tools, and only this verb reports an error.
 *
 * No tool and no prompt text is registered here. The dashboard is for the
 * person at the keyboard, and costs the model nothing.
 *
 * @module tui
 */

import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ShodhClient } from './client.js';
import type { TenantResolver } from './tools.js';
import {
  installedPath,
  installTui,
  listInstalled,
  normalizeTag,
  releaseAsset,
  TUI_BINARY,
  TuiInstallError,
  tuiRoot,
} from './tui-install.js';
import type {
  AgentRef,
  AgentTerminalLike,
  CommandInvocation,
  CommandResult,
  SandboxPolicyLike,
  ShodhConfig,
  ShodhContext,
  SubprocessLike,
  TerminalControllerLike,
} from './types.js';

/** Tab title of the terminal, and how the command result refers to it. */
export const TUI_TITLE = 'Shodh memory';

/** Default timings; tests shorten them. */
const TIMINGS = {
  /** Output silence that counts as "the shell has finished starting". */
  startupQuietMs: 300,
  /** Longest wait for the shell before typing anyway. */
  startupTimeoutMs: 15_000,
  /** How long the program must survive to count as started. */
  launchWatchMs: 1_500,
};

/** Dependencies for {@link createTui}. */
export interface TuiDeps {
  /** A {@link ShodhClient}; asked for the server version only. */
  client: ShodhClient;
  /** Normalized config. */
  cfg: ShodhConfig;
  /** The resolved API key, handed to the TUI through its environment. */
  apiKey?: string;
  /** Tenant resolver, to tell the person which profile to pick. */
  resolveUserId: TenantResolver;
  /** GitHub API root override; tests point it at a local server. */
  releaseApi?: string;
  /** Timing overrides; tests shorten them. */
  timings?: Partial<typeof TIMINGS>;
}

/** The `/shodh tui` verb. */
export interface Tui {
  /**
   * Run `/shodh tui [install [version]]`.
   * @param invocation - the command invocation.
   * @param argument - the text after `tui`.
   * @returns the command result.
   */
  run(invocation: CommandInvocation, argument: string): Promise<CommandResult>;
  /** Close the terminals this plugin still controls. */
  dispose(): void;
}

/**
 * Build the `/shodh tui` verb for one plugin fiber.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @returns the verb and its teardown.
 */
export function createTui(ctx: ShodhContext, deps: TuiDeps): Tui {
  const { client, cfg, apiKey, resolveUserId } = deps;
  const timings = { ...TIMINGS, ...deps.timings };

  /** One live terminal per session; a second `/shodh tui` points at the first. */
  const terminals = new Map<string, AgentTerminalLike>();
  /** Opens in flight, so two quick invocations share one terminal. */
  const opening = new Map<string, Promise<CommandResult>>();

  /** @returns the DSH home the host booted from, when it says. */
  function hostHome(): string | undefined {
    const profile = ctx.get?.('profileContext') as { home?: unknown } | undefined;
    return typeof profile?.home === 'string' && profile.home.length > 0 ? profile.home : undefined;
  }

  async function open(invocation: CommandInvocation): Promise<CommandResult> {
    if (!cfg.tui.enabled) {
      return { kind: 'error', text: 'The TUI is switched off (tui.enabled is false).' };
    }
    if (process.platform === 'win32') {
      return { kind: 'error', text: 'The shodh TUI is not supported on Windows yet.' };
    }
    const agent = invocation.agent;
    const controller = ctx.get?.('terminalController') as TerminalControllerLike | undefined;
    const sandboxPolicy = ctx.get?.('sandboxPolicy') as SandboxPolicyLike | undefined;
    if (
      !agent ||
      typeof controller?.openForAgent !== 'function' ||
      typeof sandboxPolicy?.resolve !== 'function'
    ) {
      return {
        kind: 'error',
        text: 'The shodh TUI needs a sidebar terminal, which only the DSH Web and Desktop apps provide.',
      };
    }

    const key = sessionKey(agent);
    const existing = terminals.get(key);
    if (existing && isLive(existing)) {
      return { kind: 'success', text: `"${TUI_TITLE}" is already open in the right panel.` };
    }
    if (existing) {
      terminals.delete(key);
      // An ended terminal the person never typed into still holds a tab.
      await existing.close().catch(() => {});
    }

    const pending = opening.get(key);
    if (pending) return pending;
    const task = launch(invocation, agent, controller, sandboxPolicy, key).finally(() => {
      opening.delete(key);
    });
    opening.set(key, task);
    return task;
  }

  async function launch(
    invocation: CommandInvocation,
    agent: AgentRef,
    controller: TerminalControllerLike,
    sandboxPolicy: SandboxPolicyLike,
    key: string,
  ): Promise<CommandResult> {
    const signal = invocation.signal ?? new AbortController().signal;
    const root = tuiRoot(hostHome());

    const binary = await resolveBinary(agent, root, signal);
    if ('error' in binary) return { kind: 'error', text: binary.error };

    const env: Record<string, string> = { SHODH_SERVER_URL: cfg.baseUrl };
    if (apiKey) env.SHODH_API_KEY = apiKey;

    let terminal: AgentTerminalLike;
    try {
      terminal = await controller.openForAgent(
        agent,
        {
          title: TUI_TITLE,
          // The TUI appends to `tui_debug.log` in its working directory. Start
          // it somewhere of ours so that file never lands in the workspace.
          cwd: await workingDirectory(root),
          cols: cfg.tui.cols,
          rows: cfg.tui.rows,
          policy: sandboxPolicy.resolve({ session: agent.session }),
          preferredShells: [],
          // Through the environment, not the command line: the key must not be
          // echoed into the terminal's scrollback.
          env,
        },
        signal,
      );
    } catch (error) {
      return { kind: 'error', text: openFailure(error) };
    }

    try {
      await shellSettled(terminal, timings.startupQuietMs, timings.startupTimeoutMs, signal);
      await terminal.write(`${launchLine(binary.path)}\r`);
      await watchLaunch(terminal, timings.launchWatchMs, signal);
    } catch (error) {
      await terminal.close().catch(() => {});
      return { kind: 'error', text: `Could not start the shodh TUI: ${messageOf(error)}` };
    }

    if (terminal.info.state !== 'running') {
      // Started and died at once: a loader error (wrong glibc, wrong CPU) is the
      // usual cause, and its message is the last thing on the screen.
      const screen = await lastLines(terminal, 6);
      await terminal.close().catch(() => {});
      const detail = screen || terminal.info.error || `exit code ${terminal.info.exitCode ?? '?'}`;
      return {
        kind: 'error',
        text: `shodh-tui exited as soon as it started (${binary.path}):\n${detail}`,
      };
    }

    terminals.set(key, terminal);
    return {
      kind: 'success',
      text: [
        `Opened "${TUI_TITLE}" in the right panel.`,
        `Pick the profile "${resolveUserId(agent)}" there to see this session's memories.`,
      ].join('\n'),
    };
  }

  /**
   * Find the binary to run: `tui.path`, then a managed install, then PATH.
   *
   * Every candidate is checked through the session's own execution provider
   * when it has one, because that is where the terminal will run it.
   */
  async function resolveBinary(
    agent: AgentRef,
    root: string,
    signal: AbortSignal,
  ): Promise<{ path: string } | { error: string }> {
    const subprocess = agent.ctx?.get?.('subprocess') as SubprocessLike | undefined;
    const locate = (command: string) =>
      typeof subprocess?.resolveExecutable === 'function'
        ? subprocess.resolveExecutable(command, undefined, signal).catch(() => undefined)
        : locateLocally(command);

    if (cfg.tui.path) {
      if (!isAbsolute(cfg.tui.path)) {
        return { error: `tui.path must be an absolute path (got ${cfg.tui.path}).` };
      }
      const configured = await locate(cfg.tui.path);
      // A configured path that does not work is a mistake to report, not a
      // reason to run some other binary.
      return configured
        ? { path: configured }
        : { error: `tui.path is not an executable file: ${cfg.tui.path}` };
    }

    const installed = await listInstalled(root);
    if (installed.length > 0) {
      const tag = await preferredTag(installed);
      const managed = await locate(installedPath(root, tag));
      if (managed) return { path: managed };
    }

    const onPath = await locate(TUI_BINARY);
    if (onPath) return { path: onPath };

    return {
      error: [
        `No ${TUI_BINARY} binary found.`,
        'Run `/shodh tui install` to download it from the shodh-memory GitHub release,',
        'or set tui.path to a binary you built.',
      ].join('\n'),
    };
  }

  /** Pick among several managed installs: configured, then the server's, then newest. */
  async function preferredTag(installed: string[]): Promise<string> {
    const configured = normalizeTag(cfg.tui.version);
    if (configured && installed.includes(configured)) return configured;
    if (installed.length > 1) {
      const server = await serverTag();
      if (server && installed.includes(server)) return server;
    }
    return installed[0] as string;
  }

  /** @returns the release tag matching the running server, when it answers. */
  async function serverTag(): Promise<string | undefined> {
    const health = await client.soft('/health', undefined, { method: 'GET', timeoutMs: 2000 });
    return normalizeTag(health?.version);
  }

  async function install(invocation: CommandInvocation, argument: string): Promise<CommandResult> {
    if (!cfg.tui.enabled) {
      return { kind: 'error', text: 'The TUI is switched off (tui.enabled is false).' };
    }
    const asset = releaseAsset(process.platform, process.arch);
    if (!asset) {
      return {
        kind: 'error',
        text: `There is no ${TUI_BINARY} download this plugin can install for ${process.platform}/${process.arch}. Build it from the shodh-memory repository and set tui.path.`,
      };
    }

    let tag: string | undefined;
    if (argument) {
      tag = normalizeTag(argument);
      if (!tag) return { kind: 'error', text: 'Usage: /shodh tui install [version, e.g. v0.2.0]' };
    } else {
      tag = normalizeTag(cfg.tui.version) ?? (await serverTag());
      if (!tag) {
        return {
          kind: 'error',
          text: 'Could not read the shodh server version to match. Name one: /shodh tui install v0.2.0',
        };
      }
    }

    const root = tuiRoot(hostHome());
    if ((await listInstalled(root)).includes(tag)) {
      return {
        kind: 'success',
        text: `${TUI_BINARY} ${tag} is already installed.\n  ${installedPath(root, tag)}\nRun /shodh tui to open it.`,
      };
    }

    try {
      const result = await installTui({
        root,
        tag,
        asset,
        apiBase: deps.releaseApi,
        signal: invocation.signal,
      });
      return {
        kind: 'success',
        text: [
          `Installed ${TUI_BINARY} ${result.tag} from ${result.asset}.`,
          `  ${result.path}`,
          `  sha256 ${result.sha256} (matches the GitHub release)`,
          'Run /shodh tui to open it.',
        ].join('\n'),
      };
    } catch (error) {
      const text = error instanceof TuiInstallError ? error.message : messageOf(error);
      return { kind: 'error', text: `Could not install ${TUI_BINARY} ${tag}: ${text}` };
    }
  }

  return {
    run(invocation, argument) {
      const [verb = ''] = argument.split(/\s+/);
      const rest = argument.slice(verb.length).trim();
      if (verb === '') return open(invocation);
      if (verb.toLowerCase() === 'install') return install(invocation, rest);
      return Promise.resolve({
        kind: 'error',
        text: 'Usage: /shodh tui            open the dashboard in the right panel\n       /shodh tui install [version]',
      });
    },
    dispose() {
      for (const terminal of terminals.values()) {
        // `close` refuses once the person has typed into the terminal; it is
        // theirs then, and stays open.
        if (terminal.info.control === 'agent') void terminal.close().catch(() => {});
      }
      terminals.clear();
    },
  };
}

/** Stable per-session key for the open-terminal map. */
function sessionKey(agent: AgentRef): string {
  return agent.id ?? agent.session?.id ?? 'default';
}

/** Whether a terminal we opened earlier is still showing a running program. */
function isLive(terminal: AgentTerminalLike): boolean {
  if (terminal.info.state !== 'running') return false;
  try {
    // Reads throw once the tab was closed and the screen released.
    terminal.read({ offset: 0, count: 1, maxBytes: 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory for the TUI to start in.
 * @param root - the managed install root, the preferred place.
 * @returns `root`, or the system temp directory when `root` cannot be created.
 */
async function workingDirectory(root: string): Promise<string> {
  try {
    await mkdir(root, { recursive: true });
    return root;
  } catch {
    return tmpdir();
  }
}

/**
 * Resolve an executable on this machine, for hosts without a subprocess
 * provider on the agent context.
 * @param command - an absolute path, or a bare name looked up on PATH.
 * @returns the absolute path, or `undefined`.
 */
async function locateLocally(command: string): Promise<string | undefined> {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/**
 * The one line typed into the terminal's shell.
 *
 * `exec` replaces the shell, so quitting the TUI ends the terminal instead of
 * dropping the person at a prompt in our state directory.
 *
 * `|| exit 127` matters as much: an interactive shell survives a failed `exec`
 * (file not visible inside the sandbox, wrong CPU architecture) and would sit
 * at its prompt looking like a successful launch. Exiting turns that into an
 * ended terminal, which is what the launch watch reports. Checked in bash and
 * dash; zsh and fish (3.0+) accept the same `exec … || exit` syntax.
 *
 * The leading space keeps it out of shell history where ignorespace is set.
 *
 * @param path - absolute path of the binary.
 * @returns the line, without the trailing carriage return.
 */
export function launchLine(path: string): string {
  return ` exec ${shellQuote(path)} || exit 127`;
}

/**
 * Quote one word for a POSIX shell.
 * @param value - the raw word.
 * @returns the word in single quotes, safe to paste after `exec`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wait until the shell has printed something and then gone quiet.
 *
 * Typing while startup files still run mostly works, since the terminal
 * buffers input, but a prompt framework that redraws late can swallow it.
 * Giving up after the timeout and typing anyway is right: a shell whose prompt
 * prints nothing would otherwise never be "ready".
 */
async function shellSettled(
  terminal: AgentTerminalLike,
  quietMs: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let revision = terminal.revision;
  let lastChange = screenText(terminal) === '' ? undefined : Date.now();
  for (;;) {
    signal.throwIfAborted();
    if (terminal.info.state !== 'running') throw new Error('the terminal shell exited at startup');
    const now = Date.now();
    if (now >= deadline) return;
    if (lastChange !== undefined && now - lastChange >= quietMs) return;
    const wake = lastChange === undefined ? deadline : Math.min(deadline, lastChange + quietMs);
    if (await changedWithin(terminal, revision, wake - now, signal)) {
      revision = terminal.revision;
      lastChange = Date.now();
    }
  }
}

/** Wait out the launch window, returning early if the terminal ends. */
async function watchLaunch(
  terminal: AgentTerminalLike,
  windowMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  let revision = terminal.revision;
  for (;;) {
    signal.throwIfAborted();
    if (terminal.info.state !== 'running') return;
    const left = deadline - Date.now();
    if (left <= 0) return;
    if (await changedWithin(terminal, revision, left, signal)) revision = terminal.revision;
  }
}

/**
 * Wait for the terminal to change, a delay to pass, or `stop` to abort.
 * @returns whether the terminal changed.
 */
async function changedWithin(
  terminal: AgentTerminalLike,
  revision: number,
  delayMs: number,
  stop: AbortSignal,
): Promise<boolean> {
  if (terminal.revision > revision) return true;
  const wait = new AbortController();
  const end = () => wait.abort();
  const timer = setTimeout(end, Math.max(0, delayMs));
  stop.addEventListener('abort', end, { once: true });
  try {
    await terminal.changed(revision, wait.signal);
    // Trust the revision, not the return: a wait that merely ended is not output.
    return terminal.revision > revision;
  } catch (error) {
    if (wait.signal.aborted) return false;
    throw error;
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', end);
  }
}

/** The rendered screen, or `''` when it cannot be read. */
function screenText(terminal: AgentTerminalLike): string {
  try {
    return terminal.read({ offset: 0, count: 200, maxBytes: 16 * 1024 }).text;
  } catch {
    return '';
  }
}

/** The last non-empty screen lines, once pending output has been applied. */
async function lastLines(terminal: AgentTerminalLike, count: number): Promise<string> {
  await terminal.drain().catch(() => {});
  return screenText(terminal)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
}

/** Turn an `openForAgent` rejection into a line the person can act on. */
function openFailure(error: unknown): string {
  if ((error as { code?: unknown } | undefined)?.code === 'terminal/limit-reached') {
    return 'This session has too many terminals open. Close a terminal tab, then run /shodh tui again.';
  }
  return `Could not open a sidebar terminal: ${messageOf(error)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
