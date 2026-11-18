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
  errorMessage,
  installedPath,
  installTui,
  listInstalled,
  normalizeTag,
  type ReleaseTag,
  releaseAsset,
  TUI_BINARY,
  tuiRoot,
} from './tui-install.js';
import {
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

/** Tab title of the terminal, and how the command result refers to it. */
export const TUI_TITLE = 'Shodh memory';

/**
 * First line of the error `/shodh tui` returns when no binary is found. The
 * start-page card (client/index.js) matches it to offer its Install button.
 */
export const MISSING_BINARY = `No ${TUI_BINARY} binary found.`;

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

  /** @returns the DSH home the host booted from, when it says. */
  function hostHome(): string | undefined {
    const profile = ctx.get?.('profileContext') as { home?: unknown } | undefined;
    return typeof profile?.home === 'string' && profile.home.length > 0 ? profile.home : undefined;
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
      await existing.close().catch(() => {});
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
    const root = tuiRoot(hostHome());

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

    terminals.set(sessionKey(agent), outcome.terminal);
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
   * @param agent - the invoking session's agent.
   * @param root - {@link tuiRoot}.
   * @param signal - cancellation.
   * @returns the absolute path, or an error message fit for the command result.
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
        MISSING_BINARY,
        'Run `/shodh tui install` to download it from the shodh-memory GitHub release,',
        'or set tui.path to a binary you built.',
      ].join('\n'),
    };
  }

  /**
   * Pick among several managed installs: configured, then the server's, then newest.
   * @param installed - from {@link listInstalled}, newest first; never empty.
   * @returns the tag to run.
   */
  async function preferredTag(installed: ReleaseTag[]): Promise<ReleaseTag> {
    const configured = normalizeTag(cfg.tui.version);
    if (configured && installed.includes(configured)) return configured;
    if (installed.length > 1) {
      const server = await serverTag();
      if (server && installed.includes(server)) return server;
    }
    return installed[0] as ReleaseTag;
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
