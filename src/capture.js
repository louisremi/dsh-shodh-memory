/**
 * Automatic memory capture.
 *
 * Runs off durable session events and the tool-result observer, so it costs the
 * model nothing: no tool call, no prompt tokens, no turn latency. Writes are
 * queued and flushed in the background.
 *
 * What gets stored, and why:
 *
 * - **Human prompts** — the cheapest reliable record of intent. Every prompt a
 *   human typed is a retrieval key for everything that followed it.
 * - **Failed tool calls** — the highest-value automatic signal in a coding
 *   harness. "Tried X, got this error" is exactly the memory that stops the
 *   agent re-running a known-bad command in a later session.
 * - **Assistant replies** — off by default. High volume, low precision: most
 *   assistant output is elaboration of a prompt already captured.
 *
 * @module capture
 */

import { createHash } from 'node:crypto';
import { extractText } from './format.js';

/** Cap on the pending-write queue; beyond it, the oldest writes are dropped. */
const MAX_QUEUED = 64;

/** Cap on remembered hashes before the oldest are evicted (FIFO). */
const MAX_HASHES = 10000;

/**
 * Install the capture listeners.
 * @param ctx - the cordis context owning the plugin fiber.
 * @param deps - wired dependencies.
 * @param deps.client - a {@link ShodhClient}.
 * @param deps.cfg - normalized config.
 * @param deps.state - shared plugin state (dedupe sets, queues).
 * @param deps.resolveUserId - `(agent?) => string` tenant resolver.
 * @returns a disposer that stops capture.
 */
export function installCapture(ctx, { client, cfg, state, resolveUserId }) {
  const opts = cfg.autoCapture;
  if (!opts.enabled) return () => {};

  /** Serialize background writes so ordering is stable and nothing blocks a turn. */
  const queue = [];
  let draining = false;

  const enqueue = (task) => {
    if (queue.length >= MAX_QUEUED) queue.shift();
    queue.push(task);
    if (draining) return;
    draining = true;
    // Yield to the event loop: capture must never extend the turn that produced it.
    setTimeout(() => { void drain(); }, 0);
  };

  const drain = async () => {
    try {
      while (queue.length > 0) {
        const task = queue.shift();
        try {
          await task();
        } catch (error) {
          ctx.logger?.debug?.(`[shodh-memory] capture write failed: ${error?.message ?? error}`);
        }
      }
    } finally {
      draining = false;
    }
  };

  /** Record a memory unless this exact content was already stored this process. */
  const store = ({ content, memoryType, tags, sessionId }) => {
    const text = content.trim();
    if (text.length < opts.minChars) return;
    const capped = text.length > opts.maxChars ? `${text.slice(0, opts.maxChars - 1)}…` : text;
    const hash = sha1(capped);
    if (state.capturedHashes.has(hash)) return;
    rememberHash(state, hash);
    enqueue(() =>
      client.remember(
        { content: capped, memoryType, tags, sessionId },
        { timeoutMs: cfg.captureTimeoutMs },
      ),
    );
  };

  // ── human prompts ──────────────────────────────────────────────────────────
  if (opts.userPrompts) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return;
      const message = event.data;
      // Only genuine human input. Plugin-injected context (including our own
      // recall block) has source.kind 'plugin' and must never be re-remembered,
      // or recalled text would feed back into the store and compound.
      if (!message || message.source?.kind !== 'user') return;
      const text = extractText(message.content);
      store({
        content: text,
        memoryType: 'Conversation',
        tags: ['prompt', 'dsh'],
        sessionId: session?.id,
      });
    });
  }

  // ── failed tool calls ──────────────────────────────────────────────────────
  if (opts.toolErrors) {
    ctx.on('tools/result', (exec, result) => {
      if (!result?.isError) return;
      // Nested PTC sub-dispatches duplicate their parent's failure surface;
      // only top-level calls are worth a memory of their own.
      if (exec?.parent !== undefined) return;
      const detail = extractText(result.content) || result.error?.message || 'unknown error';
      const reason = result.error?.info?.reason;
      const content =
        `Tool \`${exec.name}\` failed: ${detail}` + (reason && reason !== detail ? ` (${reason})` : '');
      store({
        content,
        memoryType: 'Error',
        tags: ['tool-error', exec.name, 'dsh'].filter(Boolean),
        sessionId: exec.agent?.session?.id,
      });
    });
  }

  // ── assistant replies (opt-in) ─────────────────────────────────────────────
  if (opts.assistantReplies) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const message = event.data;
      const text = extractText(message?.content);
      if (!text) return;
      store({
        content: text,
        memoryType: 'Context',
        tags: ['assistant', 'dsh'],
        sessionId: session?.id,
      });
    });
  }

  return () => {
    queue.length = 0;
  };
}

/** @returns the hex sha1 of `text`, used as a content-dedup key. */
function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Add a content hash to the bounded dedupe set, evicting the oldest at cap.
 * @param state - shared plugin state.
 * @param hash - the hash to record.
 */
function rememberHash(state, hash) {
  state.capturedHashes.add(hash);
  if (state.capturedHashes.size > MAX_HASHES) {
    const oldest = state.capturedHashes.values().next();
    if (!oldest.done) state.capturedHashes.delete(oldest.value);
  }
}
