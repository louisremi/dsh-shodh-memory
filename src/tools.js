/**
 * Model-facing tools.
 *
 * Three. shodh's own MCP surface exposes 51, and every one of those schemas
 * rides in every request whether or not the model ever calls it — roughly 7.5k
 * tokens of standing overhead. These three cost about 350, and they cover the
 * only things the model cannot do on its own: write deliberately, search
 * deeper than the auto-recall block, and delete a memory that turned out to be
 * wrong.
 *
 * Everything else — surfacing memories, capturing turns — happens without a
 * tool schema at all.
 *
 * @module tools
 */

import { MEMORY_TYPES } from './config.js';
import { normalizeMemory, renderResults } from './format.js';

/**
 * Register the enabled tools.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @param deps.client - a {@link ShodhClient}.
 * @param deps.cfg - normalized config.
 * @param deps.defineTool - the `@deepseek-ai/dsh-tools` helper.
 * @param deps.resolveUserId - `(agent?) => string` tenant resolver.
 * @returns a disposer unregistering every tool that was added.
 */
export function registerTools(ctx, { client, cfg, defineTool, resolveUserId }) {
  if (!defineTool) {
    ctx.logger?.warn?.('[shodh-memory] @deepseek-ai/dsh-tools unavailable; no memory tools registered');
    return () => {};
  }

  const disposers = [];
  const add = (definition) => disposers.push(ctx.tools.register(definition));

  if (cfg.tools.save) add(buildSaveTool(defineTool, client, resolveUserId));
  if (cfg.tools.search) add(buildSearchTool(defineTool, client, resolveUserId));
  if (cfg.tools.forget) add(buildForgetTool(defineTool, client, resolveUserId));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* an already-unwound fiber needs no second dispose */
      }
    }
  };
}

/**
 * `memory_save` — store one memory deliberately.
 * @param defineTool - the dsh-tools helper.
 * @param client - the shodh client.
 * @param resolveUserId - tenant resolver.
 * @returns the tool definition.
 */
function buildSaveTool(defineTool, client, resolveUserId) {
  return defineTool({
    name: 'memory_save',
    description:
      'Persist a fact in long-term memory so it survives this session. Use for decisions, ' +
      'preferences, constraints, and hard-won fixes worth repeating. Do not store things ' +
      'already obvious from the repo. Turn content into one self-contained statement — it ' +
      'will be read out of context later.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The memory, as one self-contained statement.',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Drives importance weighting. Default: Decision.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels for tag search.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          id: { type: 'string' },
          type: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.saved ? `Saved to memory${value.id ? ` (${value.id})` : ''}.` : 'Memory save failed.' },
      ],
    },
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (!content) throw new Error('memory_save: `content` must be a non-empty string');
      const result = await client.remember(
        {
          content,
          memoryType: args.type ?? 'Decision',
          tags: args.tags,
          sessionId: exec.agent?.session?.id,
        },
        { timeoutMs: 8000, userId: resolveUserId(exec.agent) },
      );
      return {
        saved: true,
        id: typeof result?.id === 'string' ? result.id : undefined,
        type: args.type ?? 'Decision',
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Save memory',
      kind: 'other',
      rawInput: typeof args?.content === 'string' ? args.content.slice(0, 200) : args?.content,
    }),
  });
}

/**
 * `memory_search` — query long-term memory directly.
 * @param defineTool - the dsh-tools helper.
 * @param client - the shodh client.
 * @param resolveUserId - tenant resolver.
 * @returns the tool definition.
 */
function buildSearchTool(defineTool, client, resolveUserId) {
  return defineTool({
    name: 'memory_search',
    description:
      'Search long-term memory across all past sessions. Relevant memories are already ' +
      'injected at the start of each turn; use this when you need more than that block, ' +
      'a different angle, or an exact prior decision. Returns ranked matches with ids.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to look for, in natural language.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results, 1–20. Default 5.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                content: { type: 'string', required: true },
                type: { type: 'string', required: true },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResults(value.results) }],
    },
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('memory_search: `query` must be a non-empty string');
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 5) || 5));

      const response = await client.recall(
        { query, limit, mode: 'semantic' },
        { timeoutMs: 8000, userId: resolveUserId(exec?.agent) },
      );
      const results = (response?.memories ?? [])
        .map(normalizeMemory)
        .filter(Boolean)
        .slice(0, limit)
        .map((m) => ({
          id: m.id || undefined,
          content: m.content,
          type: m.type,
          score: m.score || undefined,
        }));

      return { count: results.length, results };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Search memory',
      kind: 'search',
      rawInput: typeof args?.query === 'string' ? args.query.slice(0, 200) : args?.query,
    }),
  });
}

/**
 * `memory_forget` — delete a memory that is wrong or stale.
 * @param defineTool - the dsh-tools helper.
 * @param client - the shodh client.
 * @returns the tool definition.
 */
function buildForgetTool(defineTool, client, resolveUserId) {
  return defineTool({
    name: 'memory_forget',
    description:
      'Delete a memory by id when it is wrong, obsolete, or actively misleading. ' +
      'Get the id from memory_search. Prefer saving a correcting memory over deleting ' +
      'one that was merely incomplete.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The memory id to delete.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'boolean', required: true },
          id: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.forgotten ? `Forgot memory ${value.id ?? ''}.`.trim() : 'Nothing was deleted.' },
      ],
    },
    timeoutMs: 8000,
    async execute(args, exec) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('memory_forget: `id` must be a non-empty string');
      await client.forget(id, { timeoutMs: 8000, userId: resolveUserId(exec?.agent) });
      return { forgotten: true, id };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Forget memory',
      kind: 'other',
      rawInput: typeof args?.id === 'string' ? args.id : args?.id,
    }),
  });
}
