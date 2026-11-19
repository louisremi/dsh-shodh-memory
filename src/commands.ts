/**
 * The `/shodh` slash command.
 *
 * Human-facing control surface. Deliberately carries the operations that are
 * *not* model-facing — server status, the categorized summary, raw deletes —
 * so they cost zero model tokens while staying reachable in one keystroke.
 *
 * @module commands
 */

import { applyCleanup, type CleanupDeps, runCleanup } from './cleanup.js';
import type { ShodhClient } from './client.js';
import { normalizeMemory } from './format.js';
import type { TenantResolver } from './tools.js';
import { TUI_HELP, type Tui } from './tui.js';
import type {
  ActivityCounters,
  CommandInvocation,
  CommandResult,
  JsonRecord,
  JsonValue,
  PluginState,
  RenderableMemory,
  ShodhConfig,
  ShodhContext,
} from './types.js';

/** Dependencies for {@link registerCommand}. */
export interface CommandDeps {
  /** A {@link ShodhClient}. */
  client: ShodhClient;
  /** Normalized config. */
  cfg: ShodhConfig;
  /** Shared plugin state. */
  state: PluginState;
  /** Tenant resolver. */
  resolveUserId: TenantResolver;
  /** The cordis context, for the cleanup pass's `ctx.llm` access. */
  ctx: ShodhContext;
  /** The `createUserMessage` factory, when available (cleanup input message). */
  createUserMessage?: CleanupDeps['createUserMessage'];
  /** The `BlockAssembler` class, when available (cleanup stream assembly). */
  BlockAssembler?: CleanupDeps['BlockAssembler'];
  /** The `/shodh tui` verb. */
  tui: Tui;
}

/**
 * Register `/shodh`.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @returns a disposer unregistering the command.
 */
export function registerCommand(ctx: ShodhContext, deps: CommandDeps): () => void {
  const { client, cfg, state, resolveUserId, tui } = deps;
  return ctx.commands.register({
    name: 'shodh',
    description: 'shodh-memory: status, save, search, summary, forget, cleanup, tui',
    input: {
      hint: '[status | save <text> | search <query> | summary | forget <id> | cleanup [apply <n,n>|all] | tui]',
    },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const input = (invocation.rawInput ?? '').trim();
      const [verb = 'status', second = ''] = input.split(/\s+/);
      const argument = input.slice(verb.length).trim();
      const userId = resolveUserId(invocation.agent);

      switch (verb.toLowerCase()) {
        case 'status':
          return statusResult(client, cfg, state, userId);
        case 'save':
          return saveResult(client, argument, userId);
        case 'search':
        case 'find':
          return searchResult(client, argument, userId);
        case 'summary':
          return summaryResult(client);
        case 'forget':
        case 'delete':
          return forgetResult(client, argument, userId);
        case 'cleanup':
          return cleanupResult(deps, invocation, userId, second);
        case 'tui':
          return tui.run(invocation, argument);
        case 'help':
        case '--help':
          return { kind: 'success', text: HELP };
        default:
          return { kind: 'error', text: `Unknown subcommand "${verb}".\n\n${HELP}` };
      }
    },
  });
}

const HELP = [
  '/shodh status            Server health, tenant, breaker, plugin settings',
  '/shodh save <text>       Store a memory as a Decision',
  '/shodh search <query>    Semantic search across all sessions',
  '/shodh summary           Recent decisions, learnings, and context',
  '/shodh forget <id>       Delete one memory',
  '/shodh cleanup           LLM pass proposing merges/deletions (nothing is applied)',
  '/shodh cleanup apply     Apply numbered proposals: apply 1,3 | apply all',
  ...TUI_HELP,
].join('\n');

/**
 * Server and plugin health — the `/shodh status` dashboard.
 *
 * Rendered as four compact sections rather than a raw JSON dump: identity and
 * circuit, the tiered store, the effective config, and this process's activity.
 * Every field here is chosen to answer a question you actually ask when a memory
 * feature misbehaves — "is it even reachable", "which tenant am I", "did it
 * capture my last prompt", "how big is the injected block".
 *
 * @param client - the shodh client.
 * @param cfg - normalized config.
 * @param state - shared plugin state.
 * @param userId - the resolved tenant.
 * @returns the command result.
 */
async function statusResult(
  client: ShodhClient,
  cfg: ShodhConfig,
  state: PluginState,
  userId: string,
): Promise<CommandResult> {
  const health = await client.soft('/health', undefined, { method: 'GET', timeoutMs: 2000 });
  const reachable = health !== undefined;
  const version =
    reachable && typeof health?.version === 'string' ? (health?.version as string) : '?';
  const dot = !reachable ? '○' : health?.status === 'healthy' ? '●' : '◐';
  const statusWord = !reachable
    ? 'unreachable'
    : ((health?.status as string | undefined) ?? 'unknown');

  const lines: string[] = [`shodh-memory  v${version}  ${dot} ${statusWord}`, '─'.repeat(44)];

  // ── identity & circuit ───────────────────────────────────────────────────
  const scopeNote = cfg.userIdScope === 'workspace' ? 'workspace scope' : 'global scope';
  lines.push(`tenant    ${userId}  (${scopeNote})`);
  lines.push(`server    ${cfg.baseUrl}`);
  if (client.breakerOpen) {
    lines.push(
      `circuit   OPEN · retry in ${Math.ceil((client.openUntil - Date.now()) / 1000)}s · memory features inert`,
    );
  } else {
    lines.push(`circuit   closed · ${client.consecutiveFailures} consecutive failure(s)`);
  }

  // ── store ────────────────────────────────────────────────────────────────
  if (reachable) {
    const stats = await client.soft(`/api/users/${encodeURIComponent(userId)}/stats`, undefined, {
      method: 'GET',
      timeoutMs: 3000,
    });
    if (stats !== undefined) {
      const total = stats.total_memories ?? 0;
      const tiers = [
        `working ${stats.working_memory_count ?? 0}`,
        `session ${stats.session_memory_count ?? 0}`,
        `long-term ${stats.long_term_memory_count ?? 0}`,
      ].join(' · ');
      lines.push('');
      lines.push(`store     ${total} ${total === 1 ? 'memory' : 'memories'}   ${tiers}`);
      const graph = `graph ${stats.graph_nodes ?? 0} nodes / ${stats.graph_edges ?? 0} edges`;
      const vec = `vectors ${stats.vector_index_count ?? 0}`;
      const imp =
        typeof stats.average_importance === 'number'
          ? ` · avg importance ${stats.average_importance.toFixed(2)}`
          : '';
      lines.push(`          ${vec} · ${graph}${imp}`);
    }
  }

  // ── effective config ───────────────────────────────────────────────────────
  lines.push('');
  lines.push(
    `recall    ${cfg.autoRecall.enabled ? `on  ≤${cfg.autoRecall.maxChars} chars · ${cfg.autoRecall.maxResults}/turn · gap ${cfg.autoRecall.reuseGapTurns}` : 'off'}`,
  );
  const captureParts = [
    cfg.autoCapture.userPrompts && 'prompts',
    cfg.autoCapture.toolErrors && 'tool errors',
    cfg.autoCapture.assistantReplies && 'replies',
  ]
    .filter(Boolean)
    .join(' + ');
  lines.push(`capture   ${cfg.autoCapture.enabled ? `on  ${captureParts || '—'}` : 'off'}`);
  const toolList = [
    cfg.tools.save && 'memory_save',
    cfg.tools.search && 'memory_search',
    cfg.tools.forget && 'memory_forget',
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(`tools     ${toolList || 'none'}`);
  const route =
    cfg.cleanup.provider !== undefined && cfg.cleanup.model !== undefined
      ? `${cfg.cleanup.provider}/${cfg.cleanup.model}`
      : 'auto';
  lines.push(
    `cleanup   ${route} · ≤${cfg.cleanup.maxMemories} memories · on demand (/shodh cleanup)`,
  );

  // ── this process ─────────────────────────────────────────────────────────
  const a: Partial<ActivityCounters> = state.activity ?? {};
  lines.push('');
  const lastInject = a.lastInjectChars
    ? ` · last inject ${a.lastInjectChars} chars ${ago(a.lastInjectAt)}`
    : '';
  const lastCapture = a.lastCaptureAt ? ` · last ${ago(a.lastCaptureAt)}` : '';
  lines.push(
    `activity  ${a.captured ?? 0} captured${lastCapture} · ${a.recalled ?? 0} recalled${lastInject}`,
  );
  if ((a.captureSkipped ?? 0) > 0 || (a.recallEmpty ?? 0) > 0) {
    lines.push(
      `          ${a.captureSkipped ?? 0} capture skipped · ${a.recallEmpty ?? 0} empty recall`,
    );
  }

  return { kind: 'success', text: lines.join('\n') };
}

/**
 * Render a timestamp as a short relative string ("3s ago", "5m ago").
 * @param ts - epoch millis, or 0/undefined for "never".
 * @returns the relative label, or 'never' when unset.
 */
function ago(ts: number | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Store a memory from the command line.
 * @param client - the shodh client.
 * @param argument - the memory text.
 * @param userId - the resolved tenant.
 * @returns the command result.
 */
async function saveResult(
  client: ShodhClient,
  argument: string,
  userId: string,
): Promise<CommandResult> {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh save <text>' };
  const result = await client.soft(
    '/api/remember',
    {
      user_id: userId,
      content: argument,
      memory_type: 'Decision',
      source_type: 'dsh-cli',
    },
    { timeoutMs: 8000 },
  );
  if (result === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  return { kind: 'success', text: `Saved.${result.id ? ` id: ${result.id}` : ''}` };
}

/**
 * Search from the command line.
 * @param client - the shodh client.
 * @param argument - the query.
 * @param userId - the resolved tenant.
 * @returns the command result.
 */
async function searchResult(
  client: ShodhClient,
  argument: string,
  userId: string,
): Promise<CommandResult> {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh search <query>' };
  const response = await client.soft(
    '/api/recall',
    {
      user_id: userId,
      query: argument,
      limit: 8,
      mode: 'semantic',
    },
    { timeoutMs: 8000 },
  );
  if (response === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  const memories = ((response.memories as JsonValue[] | undefined) ?? [])
    .map(normalizeMemory)
    .filter((m): m is RenderableMemory => Boolean(m))
    .slice(0, 8);
  if (memories.length === 0) return { kind: 'success', text: 'No matching memories.' };
  return {
    kind: 'success',
    text: memories
      .map(
        (m) =>
          `- [${m.type}${m.score ? ` ${Math.round(m.score * 100)}%` : ''}] ${m.content}\n  id: ${m.id}`,
      )
      .join('\n'),
  };
}

/**
 * The categorized overview.
 * @param client - the shodh client.
 * @returns the command result.
 */
async function summaryResult(client: ShodhClient): Promise<CommandResult> {
  const result = (await client.contextSummary(6, { timeoutMs: 8000 })) as JsonRecord | undefined;
  if (result === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  const lines: string[] = [];
  for (const [label, key] of [
    ['Decisions', 'decisions'],
    ['Learnings', 'learnings'],
    ['Context', 'context'],
  ]) {
    const items = ((result[key] as JsonValue[] | undefined) ?? [])
      .map(normalizeMemory)
      .filter((m): m is RenderableMemory => Boolean(m));
    if (items.length === 0) continue;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${item.content}`);
  }
  return { kind: 'success', text: lines.length ? lines.join('\n') : 'No memories yet.' };
}

/**
 * `/shodh cleanup [apply …]` — the only token-spending path in the plugin,
 * and it never runs without a human typing it. Bare form proposes; `apply`
 * executes selected proposals from the last report.
 * @param deps - command dependencies (they carry the cleanup wiring).
 * @param invocation - the raw invocation, for optional cancellation.
 * @param userId - the resolved tenant.
 * @param second - the token after `cleanup`, `apply` or empty.
 * @returns the command result.
 */
async function cleanupResult(
  deps: CommandDeps,
  invocation: CommandInvocation,
  userId: string,
  second: string,
): Promise<CommandResult> {
  const cleanupDeps: CleanupDeps = {
    ctx: deps.ctx,
    client: deps.client,
    cfg: deps.cfg,
    state: deps.state,
    createUserMessage: deps.createUserMessage,
    BlockAssembler: deps.BlockAssembler,
  };
  const kind = second.toLowerCase() === 'apply' ? 'apply' : second === '' ? 'run' : 'usage';
  if (kind === 'usage') {
    return {
      kind: 'error',
      text: 'Usage: /shodh cleanup  — or —  /shodh cleanup apply <n,n> | all',
    };
  }
  const text =
    kind === 'run'
      ? await runCleanup(cleanupDeps, userId, invocation.signal)
      : await applyCleanup(cleanupDeps, userId, inputAfterApply(invocation), invocation.signal);
  const failed = text.startsWith('Cleanup unavailable:');
  return { kind: failed ? 'error' : 'success', text };
}

/** The argument after `apply`: proposal numbers or `all`. */
function inputAfterApply(invocation: CommandInvocation): string {
  const input = (invocation.rawInput ?? '').trim();
  const match = /^cleanup\s+apply\s+(.*)$/i.exec(input);
  return (match?.[1] ?? '').trim();
}

/**
 * Delete one memory.
 * @param client - the shodh client.
 * @param argument - the memory id.
 * @param userId - the resolved tenant.
 * @returns the command result.
 */
async function forgetResult(
  client: ShodhClient,
  argument: string,
  userId: string,
): Promise<CommandResult> {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh forget <id>' };
  const result = await client.soft(
    `/api/memory/${encodeURIComponent(argument)}?user_id=${encodeURIComponent(userId)}`,
    undefined,
    {
      method: 'DELETE',
      timeoutMs: 8000,
    },
  );
  if (result === undefined)
    return {
      kind: 'error',
      text: `Could not delete ${argument} (server unreachable or id unknown).`,
    };
  return { kind: 'success', text: `Forgot ${argument}.` };
}
