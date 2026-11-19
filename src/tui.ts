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
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ShodhClient } from './client.js';
import type { TenantResolver } from './tools.js';
import {
  installedPath,
  installTui,
  listInstalled,
  normalizeTag,
  type ReleaseTag,
  releaseAsset,
  removeInstalled,
  TUI_BINARY,
  tuiRoot,
} from './tui-install.js';
import {
  closeQuietly,
  DEFAULT_TIMINGS,
  isLive,
  launchInTerminal,
  type TerminalServices,
  type TerminalTimings,
  terminalServices,
} from './tui-terminal.js';
import type {
  AgentRef,
  AgentTerminalLike,
  CommandInvocation,
  CommandResult,
  ShodhConfig,
  ShodhContext,
  SubprocessLike,
} from './types.js';
import { errorMessage } from './util.js';

/** Tab title of the terminal, and how the command result refers to it. */
export const TUI_TITLE = 'Shodh memory';

/**
 * First line of the error `/shodh tui` returns when no binary is found. The
 * start-page card (client/index.js) matches it to offer its Install button.
 */
export const MISSING_BINARY = `No ${TUI_BINARY} binary found.`;

/** The verb's lines in `/shodh help`, also its usage message. */
export const TUI_HELP = [
  '/shodh tui               Open the shodh dashboard in the right panel',
  '/shodh tui install       Download the shodh-tui binary (or a [version] of it)',
  '/shodh tui clean [all]   Remove downloaded binaries it no longer runs',
];

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
}

/** Test seams for {@link createTui}; production passes none. */
export interface TuiTestHooks {
  /** GitHub API root; a local server in tests. */
  releaseApi?: string;
  /** Shorter waits. */
  timings?: Partial<TerminalTimings>;
}

/** The `/shodh tui` verb. */
export interface Tui {
  /**
   * Run `/shodh tui [install [version] | clean [all]]`.
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
 * @param hooks - test seams; omitted in production.
 * @returns the verb and its teardown.
 */
export function createTui(ctx: ShodhContext, deps: TuiDeps, hooks: TuiTestHooks = {}): Tui {
  const { client, cfg, apiKey, resolveUserId } = deps;
  const timings: TerminalTimings = { ...DEFAULT_TIMINGS, ...hooks.timings };

  /** One live terminal per session; a second `/shodh tui` points at the first. */
  const terminals = new Map<string, AgentTerminalLike>();
  /** Opens in flight, so two quick invocations share one terminal. */
  const opening = new Map<string, Promise<CommandResult>>();
  /** Set by `dispose`; a launch that finishes afterwards closes its terminal. */
  let disposed = false;

  /** @returns {@link tuiRoot} under the DSH home the host booted from, when it says. */
  function managedRoot(): string {
    const profile = ctx.get?.('profileContext') as { home?: unknown } | undefined;
    const home =
      typeof profile?.home === 'string' && profile.home.length > 0 ? profile.home : undefined;
    return tuiRoot(home);
  }

  /**
   * `/shodh tui`: open the TUI for the invoking session, or point at the one
   * already open. Concurrent invocations for one session share a launch.
   * @param invocation - the command invocation.
   * @returns the command result.
   */
  async function open(invocation: CommandInvocation): Promise<CommandResult> {
    if (process.platform === 'win32') {
      return { kind: 'error', text: 'The shodh TUI is not supported on Windows yet.' };
    }
    const agent = invocation.agent;
    const services = terminalServices(ctx);
    if (!agent || !services) {
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
      await closeQuietly(existing);
    }

    const pending = opening.get(key);
    if (pending) return pending;
    const task = launch(invocation, agent, services).finally(() => {
      opening.delete(key);
    });
    opening.set(key, task);
    return task;
  }

  /**
   * Find the binary and start it in a new sidebar terminal.
   * @param invocation - the command invocation; its signal cancels the launch.
   * @param agent - the invoking session's agent.
   * @param services - {@link terminalServices}.
   * @returns the command result; on success the terminal is remembered for the session.
   */
  async function launch(
    invocation: CommandInvocation,
    agent: AgentRef,
    services: TerminalServices,
  ): Promise<CommandResult> {
    const signal = invocation.signal ?? new AbortController().signal;
    const root = managedRoot();

    const binary = await resolveBinary(agent, root, signal);
    if ('error' in binary) return { kind: 'error', text: binary.error };

    const env: Record<string, string> = { SHODH_SERVER_URL: cfg.baseUrl };
    if (apiKey) env.SHODH_API_KEY = apiKey;

    const outcome = await launchInTerminal(
      services,
      agent,
      {
        title: TUI_TITLE,
        binary: binary.path,
        // The TUI appends to `tui_debug.log` in its working directory. Start
        // it somewhere of ours so that file never lands in the workspace.
        cwd: root,
        cols: cfg.tui.cols,
        rows: cfg.tui.rows,
        env,
      },
      timings,
      signal,
    );
    if ('error' in outcome) return { kind: 'error', text: outcome.error };
    if (disposed) {
      // The plugin was unloaded mid-launch: nothing would ever close this one.
      await closeQuietly(outcome.terminal);
      return { kind: 'error', text: 'The shodh plugin was unloaded. Run /shodh tui again.' };
    }

    terminals.set(sessionKey(agent), outcome.terminal);
    const lines = [
      `Opened "${TUI_TITLE}" in the right panel.`,
      `Pick the profile "${resolveUserId(agent)}" there to see this session's memories.`,
    ];
    if (binary.mismatch) {
      const { running, server } = binary.mismatch;
      lines.push(
        `This is ${TUI_BINARY} ${running}, but the server runs ${server}. Run /shodh tui install to match it.`,
      );
    }
    return { kind: 'success', text: lines.join('\n') };
  }

  /**
   * Find the binary to run: `tui.path`, then a managed install, then PATH.
   *
   * Every candidate is checked through the session's own execution provider
   * when it has one, because that is where the terminal will run it.
   * @param agent - the invoking session's agent.
   * @param root - {@link tuiRoot}.
   * @param signal - cancellation.
   * @returns the absolute path, or an error message fit for the command result.
   *   A managed install that is not the server's version carries both versions.
   */
  async function resolveBinary(
    agent: AgentRef,
    root: string,
    signal: AbortSignal,
  ): Promise<
    { path: string; mismatch?: { running: ReleaseTag; server: ReleaseTag } } | { error: string }
  > {
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
      const { tag, server } = await preferredTag(installed);
      const managed = await locate(installedPath(root, tag));
      if (managed) {
        // A server upgrade does not install a new TUI; say so rather than
        // quietly running one that may not speak its API.
        return server && server !== tag
          ? { path: managed, mismatch: { running: tag, server } }
          : { path: managed };
      }
    }

    const onPath = await locate(TUI_BINARY);
    if (onPath) return { path: onPath };

    return {
      error: [
        MISSING_BINARY,
        'Run `/shodh tui install` to download it from the shodh-memory GitHub release,',
        'or set tui.path to a binary you built.',
      ].join('\n'),
    };
  }

  /**
   * Pick among managed installs: configured, then the server's, then newest.
   * @param installed - from {@link listInstalled}, newest first; never empty.
   * @returns the tag to run, and the server's tag when it answered and no
   *   version is configured (a configured version is a deliberate choice).
   */
  async function preferredTag(
    installed: ReleaseTag[],
  ): Promise<{ tag: ReleaseTag; server?: ReleaseTag }> {
    const configured = normalizeTag(cfg.tui.version);
    if (configured && installed.includes(configured)) return { tag: configured };
    const server = await serverTag();
    if (server && installed.includes(server)) return { tag: server, server };
    return { tag: installed[0] as ReleaseTag, server };
  }

  /** @returns the release tag matching the running server, when it answers. */
  async function serverTag(): Promise<ReleaseTag | undefined> {
    const health = await client.soft('/health', undefined, { method: 'GET', timeoutMs: 2000 });
    return normalizeTag(health?.version);
  }

  /**
   * `/shodh tui install [version]`: download and verify one release's binary.
   * @param invocation - the command invocation; its signal cancels the download.
   * @param argument - the version, or empty for the configured or server version.
   * @returns the command result.
   */
  async function install(invocation: CommandInvocation, argument: string): Promise<CommandResult> {
    const asset = releaseAsset(process.platform, process.arch);
    if (!asset) {
      return {
        kind: 'error',
        text: `There is no ${TUI_BINARY} download this plugin can install for ${process.platform}/${process.arch}. Build it from the shodh-memory repository and set tui.path.`,
      };
    }

    let tag: ReleaseTag | undefined;
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

    const root = managedRoot();
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
        apiBase: hooks.releaseApi,
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
      return {
        kind: 'error',
        text: `Could not install ${TUI_BINARY} ${tag}: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * `/shodh tui clean [all]`: delete managed installs.
   * @param argument - `all` to delete every one; empty to keep the one `/shodh tui` runs.
   * @returns the command result.
   */
  async function clean(argument: string): Promise<CommandResult> {
    const everything = argument.toLowerCase() === 'all';
    if (argument && !everything) {
      return { kind: 'error', text: ['Usage:', ...TUI_HELP].join('\n') };
    }
    const root = managedRoot();
    const installed = await listInstalled(root);
    const keep =
      everything || installed.length === 0 ? undefined : (await preferredTag(installed)).tag;
    const doomed = installed.filter((tag) => tag !== keep);
    const removed: ReleaseTag[] = [];
    const failed: string[] = [];
    for (const tag of doomed) {
      try {
        // A TUI already running from it keeps running: the open file outlives its name.
        await removeInstalled(root, tag);
        removed.push(tag);
      } catch (error) {
        failed.push(`${tag}: ${errorMessage(error)}`);
      }
    }
    const lines = [
      removed.length > 0
        ? `Removed ${TUI_BINARY} ${removed.join(', ')}.`
        : `No ${TUI_BINARY} download to remove.`,
    ];
    if (keep) lines.push(`Kept ${keep}, the one /shodh tui runs.`);
    if (failed.length > 0) lines.push('Could not remove:', ...failed.map((line) => `  ${line}`));
    return { kind: failed.length > 0 ? 'error' : 'success', text: lines.join('\n') };
  }

  return {
    run(invocation, argument) {
      if (!cfg.tui.enabled) {
        return Promise.resolve({
          kind: 'error',
          text: 'The TUI is switched off (tui.enabled is false).',
        });
      }
      const [verb = ''] = argument.split(/\s+/);
      const rest = argument.slice(verb.length).trim();
      if (verb === '') return open(invocation);
      if (verb.toLowerCase() === 'install') return install(invocation, rest);
      if (verb.toLowerCase() === 'clean') return clean(rest);
      return Promise.resolve({
        kind: 'error',
        text: ['Usage:', ...TUI_HELP].join('\n'),
      });
    },
    dispose() {
      disposed = true;
      for (const terminal of terminals.values()) {
        // A terminal the person has typed into is theirs, and stays open.
        if (terminal.info.control === 'agent') void closeQuietly(terminal);
      }
      terminals.clear();
    },
  };
}

/** Stable per-session key for the open-terminal map. */
function sessionKey(agent: AgentRef): string {
  return agent.id ?? agent.session?.id ?? 'default';
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
