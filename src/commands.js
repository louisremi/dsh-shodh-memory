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
 * Server and plugin health.
 * @param client - the shodh client.
 * @param cfg - normalized config.
 * @param state - shared plugin state.
 * @param userId - the resolved tenant.
 * @returns the command result.
 */
async function statusResult(client, cfg, state, userId) {
  const lines = [`tenant: ${userId}`, `server: ${cfg.baseUrl}`];

  const health = await client.soft('/health', undefined, { method: 'GET', timeoutMs: 2000 });
  lines.push(
    health === undefined
      ? 'status: UNREACHABLE (circuit may be open — memory features are inert until it recovers)'
      : `status: ok ${JSON.stringify(health)}`,
  );

  if (client.breakerOpen) {
    lines.push(`circuit: OPEN, retry in ${Math.ceil((client.openUntil - Date.now()) / 1000)}s`);
  } else {
    lines.push(`circuit: closed (${client.consecutiveFailures} consecutive failure(s))`);
  }

  const stats = await client.soft(`/api/users/${encodeURIComponent(userId)}/stats`, undefined, {
    method: 'GET',
    timeoutMs: 3000,
  });
  if (stats !== undefined) {
    lines.push(`store: ${compact(stats)}`);
  }

  lines.push(
    `recall: ${cfg.autoRecall.enabled ? `on (≤${cfg.autoRecall.maxChars} chars, ${cfg.autoRecall.maxResults} memories/turn)` : 'off'}`,
  );
  lines.push(
    `capture: ${cfg.autoCapture.enabled ? `on (${[cfg.autoCapture.userPrompts && 'prompts', cfg.autoCapture.toolErrors && 'tool errors', cfg.autoCapture.assistantReplies && 'replies'].filter(Boolean).join(', ')})` : 'off'}`,
  );
  lines.push(
    `tools: ${[cfg.tools.save && 'memory_save', cfg.tools.search && 'memory_search', cfg.tools.forget && 'memory_forget'].filter(Boolean).join(', ') || 'none'}`,
  );
  lines.push(`captured this process: ${state.capturedHashes.size}`);

  return { kind: 'success', text: lines.join('\n') };
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

/** @returns a one-line rendering of an arbitrary stats object. */
function compact(object) {
  return Object.entries(object)
    .filter(([, value]) => typeof value !== 'object' || value === null)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}
