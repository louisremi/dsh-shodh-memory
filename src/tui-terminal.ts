/**
 * Starting one program in a DSH sidebar terminal and confirming it runs.
 *
 * This is the terminal half of `/shodh tui`: it knows nothing about shodh,
 * releases, or commands. It opens an agent terminal under the session's
 * sandbox policy, types one `exec` line into its shell, and watches long enough
 * to tell a running program from one that died at once.
 *
 * @module tui-terminal
 */

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { errorMessage, linkedSignal } from './tui-install.js';
import type {
  AgentRef,
  AgentTerminalLike,
  SandboxPolicyLike,
  ShodhContext,
  TerminalControllerLike,
} from './types.js';

/** The two Web/Desktop services a sidebar terminal needs; they always travel together. */
export interface TerminalServices {
  /** Allocates the sidebar terminal. */
  controller: TerminalControllerLike;
  /** Resolves the session's file-effect policy, which the terminal runs under. */
  sandboxPolicy: SandboxPolicyLike;
}

/**
 * Look the terminal services up on the plugin context.
 * @param ctx - the cordis context owning the plugin fiber.
 * @returns both services, or `undefined` when the host lacks either (headless).
 */
export function terminalServices(ctx: ShodhContext): TerminalServices | undefined {
  const controller = ctx.get?.('terminalController') as TerminalControllerLike | undefined;
  const sandboxPolicy = ctx.get?.('sandboxPolicy') as SandboxPolicyLike | undefined;
  if (typeof controller?.openForAgent !== 'function') return undefined;
  if (typeof sandboxPolicy?.resolve !== 'function') return undefined;
  return { controller, sandboxPolicy };
}

/** How long each launch phase waits. */
export interface TerminalTimings {
  /** Output silence that counts as "the shell has finished starting". */
  startupQuietMs: number;
  /** Longest wait for the shell before typing anyway. */
  startupTimeoutMs: number;
  /** How long the program must survive to count as started. */
  launchWatchMs: number;
}

/** Production timings. */
export const DEFAULT_TIMINGS: TerminalTimings = {
  startupQuietMs: 300,
  startupTimeoutMs: 15_000,
  launchWatchMs: 1_500,
};

/** What to run, and the terminal to run it in. */
export interface LaunchRequest {
  /** Tab title. */
  title: string;
  /** Absolute path of the program. */
  binary: string;
  /** Preferred working directory; the system temp directory if it cannot be created. */
  cwd: string;
  cols: number;
  rows: number;
  /** Extra environment for the shell, and so for the program. */
  env: Record<string, string>;
}

/** A started program's terminal, or the reason it did not start. */
export type LaunchOutcome = { terminal: AgentTerminalLike } | { error: string };

/**
 * Open a sidebar terminal for an agent and start one program in it.
 * @param services - {@link terminalServices}.
 * @param agent - the session's agent; the terminal belongs to its session.
 * @param request - the program and terminal settings.
 * @param timings - {@link DEFAULT_TIMINGS}, or shorter in tests.
 * @param signal - cancels the whole launch.
 * @returns the running terminal, or an error message fit for the command result.
 *   A terminal that failed to start has already been closed.
 */
export async function launchInTerminal(
  services: TerminalServices,
  agent: AgentRef,
  request: LaunchRequest,
  timings: TerminalTimings,
  signal: AbortSignal,
): Promise<LaunchOutcome> {
  let terminal: AgentTerminalLike;
  try {
    terminal = await services.controller.openForAgent(
      agent,
      {
        title: request.title,
        cwd: await workingDirectory(request.cwd),
        cols: request.cols,
        rows: request.rows,
        policy: services.sandboxPolicy.resolve({ session: agent.session }),
        preferredShells: [],
        // Through the environment, not the command line: secrets in it must
        // not be echoed into the terminal's scrollback.
        env: request.env,
      },
      signal,
    );
  } catch (error) {
    return { error: openFailure(error) };
  }

  try {
    await shellSettled(terminal, timings.startupQuietMs, timings.startupTimeoutMs, signal);
    await terminal.write(`${launchLine(request.binary)}\r`);
    await watchLaunch(terminal, timings.launchWatchMs, signal);
  } catch (error) {
    await terminal.close().catch(() => {});
    return { error: `Could not start the shodh TUI: ${errorMessage(error)}` };
  }

  if (terminal.info.state !== 'running') {
    // Started and died at once: a loader error (wrong glibc, wrong CPU) is the
    // usual cause, and its message is the last thing on the screen.
    const screen = await lastLines(terminal, 6);
    await terminal.close().catch(() => {});
    const detail = screen || terminal.info.error || `exit code ${terminal.info.exitCode ?? '?'}`;
    return { error: `shodh-tui exited as soon as it started (${request.binary}):\n${detail}` };
  }
  return { terminal };
}

/**
 * Whether a terminal opened earlier is still showing a running program.
 * @param terminal - a terminal from {@link launchInTerminal}.
 * @returns false once the program ended or the tab was closed.
 */
export function isLive(terminal: AgentTerminalLike): boolean {
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
 * A directory for the program to start in.
 * @param preferred - where it should start; created when missing.
 * @returns `preferred`, or the system temp directory when it cannot be created.
 */
async function workingDirectory(preferred: string): Promise<string> {
  try {
    await mkdir(preferred, { recursive: true });
    return preferred;
  } catch {
    return tmpdir();
  }
}

/**
 * Wait until the shell has printed something and then gone quiet.
 *
 * Typing while startup files still run mostly works, since the terminal
 * buffers input, but a prompt framework that redraws late can swallow it.
 * Giving up after the timeout and typing anyway is right: a shell whose prompt
 * prints nothing would otherwise never be "ready".
 *
 * @param terminal - the freshly opened terminal.
 * @param quietMs - silence that counts as settled.
 * @param timeoutMs - longest wait.
 * @param signal - cancellation.
 * @throws when the shell exits or `signal` aborts.
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

/**
 * Wait out the launch window, returning early if the terminal ends.
 * @param terminal - the terminal the program was started in.
 * @param windowMs - how long to watch.
 * @param signal - cancellation.
 * @throws when `signal` aborts.
 */
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
 * @param terminal - the terminal to watch.
 * @param revision - the revision already seen.
 * @param delayMs - longest wait.
 * @param stop - ends the wait early.
 * @returns whether the terminal changed.
 */
async function changedWithin(
  terminal: AgentTerminalLike,
  revision: number,
  delayMs: number,
  stop: AbortSignal,
): Promise<boolean> {
  if (terminal.revision > revision) return true;
  const wait = linkedSignal(stop, Math.max(0, delayMs));
  try {
    await terminal.changed(revision, wait.signal);
    // Trust the revision, not the return: a wait that merely ended is not output.
    return terminal.revision > revision;
  } catch (error) {
    if (wait.signal.aborted) return false;
    throw error;
  } finally {
    wait.dispose();
  }
}

/**
 * The rendered screen.
 * @param terminal - the terminal to read.
 * @returns its text, or `''` when it cannot be read.
 */
function screenText(terminal: AgentTerminalLike): string {
  try {
    return terminal.read({ offset: 0, count: 200, maxBytes: 16 * 1024 }).text;
  } catch {
    return '';
  }
}

/**
 * The last non-empty screen lines, once pending output has been applied.
 * @param terminal - the terminal to read.
 * @param count - how many lines.
 * @returns the lines joined with newlines.
 */
async function lastLines(terminal: AgentTerminalLike, count: number): Promise<string> {
  await terminal.drain().catch(() => {});
  return screenText(terminal)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
}

/**
 * Turn an `openForAgent` rejection into a line the person can act on.
 * @param error - the rejection.
 * @returns the message.
 */
function openFailure(error: unknown): string {
  if ((error as { code?: unknown } | undefined)?.code === 'terminal/limit-reached') {
    return 'This session has too many terminals open. Close a terminal tab, then run /shodh tui again.';
  }
  return `Could not open a sidebar terminal: ${errorMessage(error)}`;
}
