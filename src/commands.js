/**
 * The `/shodh` slash command.
 *
 * Human-facing control surface. Deliberately carries the operations that are
 * *not* model-facing — server status, the categorized summary, raw deletes —
 * so they cost zero model tokens while staying reachable in one keystroke.
 *
 * @module commands
 */

import { normalizeMemory } from './format.js';

/**
 * Register `/shodh`.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @param deps.client - a {@link ShodhClient}.
 * @param deps.cfg - normalized config.
 * @param deps.state - shared plugin state.
 * @param deps.resolveUserId - `(agent?) => string` tenant resolver.
 * @returns a disposer unregistering the command.
 */
export function registerCommand(ctx, { client, cfg, state, resolveUserId }) {
  return ctx.commands.register({
    name: 'shodh',
    description: 'shodh-memory: status, save, search, summary, forget',
    input: { hint: '[status | save <text> | search <query> | summary | forget <id>]' },
    async handler(invocation) {
      const input = (invocation.rawInput ?? '').trim();
      const [verb = 'status', ...rest] = input.split(/\s+/);
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
async function statusResult(client, cfg, state, userId) {
  const health = await client.soft('/health', undefined, { method: 'GET', timeoutMs: 2000 });
  const reachable = health !== undefined;
  const version = reachable && typeof health.version === 'string' ? health.version : '?';
  const dot = !reachable ? '○' : health.status === 'healthy' ? '●' : '◐';
  const statusWord = !reachable ? 'unreachable' : health.status ?? 'unknown';

  const lines = [
    `shodh-memory  v${version}  ${dot} ${statusWord}`,
    '─'.repeat(44),
  ];

  // ── identity & circuit ───────────────────────────────────────────────────
  const scopeNote = cfg.userIdScope === 'workspace' ? 'workspace scope' : 'global scope';
  lines.push(`tenant    ${userId}  (${scopeNote})`);
  lines.push(`server    ${cfg.baseUrl}`);
  if (client.breakerOpen) {
    lines.push(`circuit   OPEN · retry in ${Math.ceil((client.openUntil - Date.now()) / 1000)}s · memory features inert`);
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
      const imp = typeof stats.average_importance === 'number' ? ` · avg importance ${stats.average_importance.toFixed(2)}` : '';
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
  ].filter(Boolean).join(' + ');
  lines.push(`capture   ${cfg.autoCapture.enabled ? `on  ${captureParts || '—'}` : 'off'}`);
  const toolList = [
    cfg.tools.save && 'memory_save',
    cfg.tools.search && 'memory_search',
    cfg.tools.forget && 'memory_forget',
  ].filter(Boolean).join(' · ');
  lines.push(`tools     ${toolList || 'none'}`);

  // ── this process ─────────────────────────────────────────────────────────
  const a = state.activity ?? {};
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
function ago(ts) {
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
 * @returns the command result.
 */
async function saveResult(client, argument, userId) {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh save <text>' };
  const result = await client.soft('/api/remember', {
    user_id: userId,
    content: argument,
    memory_type: 'Decision',
    source_type: 'dsh-cli',
  }, { timeoutMs: 8000 });
  if (result === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  return { kind: 'success', text: `Saved.${result.id ? ` id: ${result.id}` : ''}` };
}

/**
 * Search from the command line.
 * @param client - the shodh client.
 * @param argument - the query.
 * @returns the command result.
 */
async function searchResult(client, argument, userId) {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh search <query>' };
  const response = await client.soft('/api/recall', {
    user_id: userId,
    query: argument,
    limit: 8,
    mode: 'semantic',
  }, { timeoutMs: 8000 });
  if (response === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  const memories = (response.memories ?? []).map(normalizeMemory).filter(Boolean).slice(0, 8);
  if (memories.length === 0) return { kind: 'success', text: 'No matching memories.' };
  return {
    kind: 'success',
    text: memories
      .map((m) => `- [${m.type}${m.score ? ` ${Math.round(m.score * 100)}%` : ''}] ${m.content}\n  id: ${m.id}`)
      .join('\n'),
  };
}

/**
 * The categorized overview.
 * @param client - the shodh client.
 * @returns the command result.
 */
async function summaryResult(client) {
  const result = await client.contextSummary(6, { timeoutMs: 8000 });
  if (result === undefined) return { kind: 'error', text: 'Could not reach the shodh server.' };
  const lines = [];
  for (const [label, key] of [['Decisions', 'decisions'], ['Learnings', 'learnings'], ['Context', 'context']]) {
    const items = (result[key] ?? []).map(normalizeMemory).filter(Boolean);
    if (items.length === 0) continue;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${item.content}`);
  }
  return { kind: 'success', text: lines.length ? lines.join('\n') : 'No memories yet.' };
}

/**
 * Delete one memory.
 * @param client - the shodh client.
 * @param argument - the memory id.
 * @returns the command result.
 */
async function forgetResult(client, argument, userId) {
  if (!argument) return { kind: 'error', text: 'Usage: /shodh forget <id>' };
  const result = await client.soft(`/api/memory/${encodeURIComponent(argument)}?user_id=${encodeURIComponent(userId)}`, undefined, {
    method: 'DELETE',
    timeoutMs: 8000,
  });
  if (result === undefined) return { kind: 'error', text: `Could not delete ${argument} (server unreachable or id unknown).` };
  return { kind: 'success', text: `Forgot ${argument}.` };
}

