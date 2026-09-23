/**
 * Automatic recall.
 *
 * Surfaces relevant memories at the start of a turn without the model asking,
 * which is the whole point of a memory layer: an agent that has to remember to
 * query its memory is an agent that will not.
 *
 * ## Why this hooks `agent/pre-step` and not a `systemPrompt.context`
 *
 * `systemPrompt.context` is the better seam for *state* that changes rarely —
 * the loop re-materializes it only when the rendered text changes, so a stable
 * block preserves the prompt cache. It is the wrong seam here for one reason:
 * its provider receives only the assembly scope, never the user's message. A
 * recall that cannot see the question cannot answer it.
 *
 * `agent/pre-step` does see the claimed messages, and its returned decision is
 * authoritative — `dsh-agent-loop` takes `decision.messages` straight through
 * after the waterfall.
 *
 * ## The one way to get this wrong
 *
 * Build the replacement from the incoming `payload.messages`. The innermost
 * default of this waterfall appends the runtime-context message to the claimed
 * batch; a listener that reconstructs from the payload silently drops it, and
 * nothing reports the loss. Always `await next()` first and modify **its
 * result**. This mirrors what first-party `dsh-agent-instructions` does.
 *
 * @module recall
 */

import {
  extractText,
  normalizeMemory,
  renderRecallBlock,
  toQueryText,
} from './format.js';

/**
 * Install the auto-recall listener.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @param deps.client - a {@link ShodhClient}.
 * @param deps.cfg - normalized config.
 * @param deps.state - shared plugin state (injection ledger).
 * @param deps.createUserMessage - the `@deepseek-ai/dsh-llm` factory.
 * @param deps.resolveUserId - `(agent?) => string` tenant resolver.
 * @returns a disposer (the listener is owned by the fiber).
 */
export function installRecall(ctx, { client, cfg, state, createUserMessage, resolveUserId }) {
  const opts = cfg.autoRecall;
  if (!opts.enabled || !createUserMessage) return () => {};

  ctx.on('agent/pre-step', async (payload, next) => {
    // Resolve the downstream decision FIRST. Everything we add rides on top of
    // whatever the rest of the waterfall produced — see the module note.
    const decision = await next();

    if (decision.kind !== 'enter') return decision;
    // Once per turn. Injecting at every step would re-pay the block for each
    // tool round inside the same turn, which is where token cost compounds.
    if (payload.step !== 1) return decision;
    if (payload.signal?.aborted) return decision;

    const prompt = lastHumanText(decision.messages);
    if (!prompt || prompt.length < opts.minPromptChars) return decision;

    const query = toQueryText(prompt, opts.queryChars);
    if (query.length < opts.minPromptChars) return decision;

    // /api/recall, not /api/proactive_context. Verified against a live shodh
    // 0.2.0 server: proactive_context returns the correct response *shape* but
    // always zero memories — on this version it surfaces reminders/todos, not
    // stored memories. /api/recall is the endpoint that actually returns
    // ranked memories (score 0.95 on an exact match). The response carries a
    // `memories` array either way, so selectFresh() is unchanged.
    const response = await client.recall(
      { query, limit: opts.maxResults + 4 },
      { timeoutMs: cfg.recallTimeoutMs },
    ).catch(() => undefined);

    if (payload.signal?.aborted) return decision;

    const fresh = selectFresh(payload.agent, response, state, opts, payload.turn);
    const block = renderRecallBlock(fresh, opts.maxChars);
    if (!block) {
      state.activity.recallEmpty += 1;
      return decision;
    }

    state.activity.recalled += 1;
    state.activity.lastInjectChars = block.length;
    state.activity.lastInjectAt = Date.now();

    const message = createUserMessage({
      content: [{ type: 'text', text: block }],
      // DSH 0.1.7 upgraded the session log to format v4, which retired the
      // `{ kind: 'plugin', plugin: <name> }` wrapper: admission now throws
      // "format v4 message requires a producer-owned source kind" for any
      // source whose kind is literally 'plugin'. Every producer owns its own
      // kind instead. This is the exact shape upstream's own v3->v4 migration
      // generates for a third-party plugin (producerKind() in
      // @deepseek-ai/dsh-session-format-v3-to-v4 falls back to
      // `plugin:${name}` for names it does not recognise, and drops the now
      // redundant `plugin` field while preserving other keys such as `form`).
      source: { kind: 'plugin:shodh-memory', form: 'recall' },
    });

    return { ...decision, messages: [...decision.messages, message] };
  });

  return () => {};
}

/**
 * Pick the memories worth injecting this turn.
 *
 * Two filters, both about token cost:
 *
 * 1. **Relevance floor.** shodh returns a ranked list whether or not anything
 *    actually matched; below the floor the tail is noise that reads as
 *    authoritative.
 * 2. **Reuse gap.** A memory injected at turn N is still sitting in the
 *    context window. Re-injecting it at N+1 is paying twice for the same
 *    tokens, so it is suppressed until `reuseGapTurns` have passed.
 *
 * @param agent - the agent whose turn is being assembled.
 * @param response - the proactive-context response.
 * @param state - shared plugin state (the injection ledger).
 * @param opts - the auto-recall config section.
 * @param turn - the current turn number.
 * @returns up to `maxResults` normalized memories worth injecting.
 */
function selectFresh(agent, response, state, opts, turn) {
  if (!response) return [];

  const raw = [...(response.memories ?? []), ...(response.relevant_facts ?? [])];
  const ledger = ledgerFor(state, agent);

  const out = [];
  for (const entry of raw) {
    const memory = normalizeMemory(entry);
    if (!memory) continue;
    if (memory.score > 0 && memory.score < RELEVANCE_FLOOR) continue;

    const key = memory.id || memory.content.slice(0, 120);
    const last = ledger.get(key);
    if (last !== undefined && turn - last < opts.reuseGapTurns) continue;

    ledger.set(key, turn);
    out.push(memory);
    if (out.length >= opts.maxResults) break;
  }
  return out;
}

/**
 * Memories below this relevance are not worth a line of context.
 *
 * Deliberately not zero: shodh's spreading activation legitimately surfaces
 * weakly-linked neighbours, and a strict floor would kill the recall paths that
 * make the graph useful. This cuts the long tail, not the signal.
 */
const RELEVANCE_FLOOR = 0.2;

/**
 * Get (or create) the per-session injection ledger.
 * @param state - shared plugin state.
 * @param agent - the agent whose session keys the ledger.
 * @returns a Map of memory key → last-injected turn.
 */
function ledgerFor(state, agent) {
  const id = String(agent?.session?.id ?? agent?.id ?? 'global');
  let ledger = state.injectedTurns.get(id);
  if (!ledger) {
    ledger = new Map();
    state.injectedTurns.set(id, ledger);
  }
  return ledger;
}

/**
 * The most recent genuine human message in a claimed batch.
 *
 * Plugin-injected messages are skipped so a recalled block never becomes the
 * query for the next recall — the feedback loop that turns a memory store into
 * an echo chamber.
 *
 * @param messages - the decision's message batch.
 * @returns the text, or `''` when the batch holds no human input.
 */
function lastHumanText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (message.source?.kind !== 'user') continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return '';
}
