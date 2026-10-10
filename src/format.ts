/**
 * Text extraction and compact rendering.
 *
 * Two rendering paths, two budgets. The injected recall block is the one place
 * this plugin writes into the model's context on every turn, so its formatting IS
 * the token budget: one line per memory, no decoration, hard cap enforced by
 * truncation from the tail — never a "…and 12 more" line that itself costs the
 * tokens it was trying to save.
 *
 * Search results are the opposite case. The model asked for them and `limit` is
 * already its own budget control, so they share the one-line shape but NOT the
 * cap. Clipping a requested result at the always-on block's budget makes
 * `memory_search` unable to answer the one question it exists to answer — "what
 * did that memory actually say" — and an agent that cannot get an answer from the
 * tool will go and get one somewhere worse.
 *
 * @module format
 */

import type { JsonRecord, RenderableMemory } from './types.js';

/**
 * Flatten a message's content blocks into plain text.
 *
 * Non-text blocks (images, files) contribute nothing to a memory query and are
 * dropped rather than described.
 *
 * @param content - a message `content` value: a string or an array of blocks.
 * @returns the concatenated text.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const part = block as JsonRecord;
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Normalize one memory record out of a shodh response.
 *
 * shodh has returned memories bare, nested under `experience`, and with the
 * type field renamed across versions; this reads every shape so the plugin does
 * not break on a server upgrade.
 *
 * @param raw - one entry from a `memories` array.
 * @returns the normalized view, with empty strings/zeroes where unknown.
 */
export function normalizeMemory(raw: unknown): RenderableMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const experience = (
    record.experience && typeof record.experience === 'object' ? record.experience : {}
  ) as Record<string, unknown>;
  const content = firstString(record.content, experience.content) ?? '';
  if (!content) return null;
  return {
    id: firstString(record.id, experience.id) ?? '',
    content,
    type:
      firstString(record.memory_type, experience.memory_type, experience.experience_type) ??
      'Observation',
    tier: firstString(record.tier),
    score: numberOr(record.relevance_score, numberOr(record.score, numberOr(record.importance, 0))),
    tags: Array.isArray(record.tags)
      ? record.tags.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

/** @returns the first argument that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** @returns `value` when it is a finite number, else `fallback`. */
function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Per-line cap for the ALWAYS-ON recall block, passed explicitly at its call
 * site. It is a standing per-turn cost, so it stays deliberately small; it is
 * not a cap on anything the model asked for.
 */
export const RECALL_LINE_MAX_CHARS = 220;

/**
 * Collapse a memory's content into a single compact line.
 *
 * Newlines become spaces and runs of whitespace collapse, because the block is
 * read as an index of facts, not as prose.
 *
 * @param memory - a {@link normalizeMemory} result.
 * @param maxChars - per-line cap; `0` renders the content in full.
 * @returns the one-line rendering.
 */
export function memoryLine(memory: RenderableMemory, maxChars = RECALL_LINE_MAX_CHARS): string {
  const flat = memory.content.replace(/\s+/g, ' ').trim();
  const cap = Number.isFinite(maxChars) ? Math.max(0, maxChars) : RECALL_LINE_MAX_CHARS;
  const body = cap > 0 && flat.length > cap ? `${flat.slice(0, cap - 1).trimEnd()}…` : flat;
  const score = memory.score > 0 ? ` ${Math.round(clamp01(memory.score) * 100)}%` : '';
  return `- [${memory.type}${score}] ${body}`;
}

/** @returns `value` clamped to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Render the auto-recall block: a short header plus one line per memory, cut to
 * `maxChars` overall.
 *
 * @param memories - normalized memories.
 * @param maxChars - hard cap on the whole block.
 * @returns the block text, or `''` when there is nothing to say.
 */
export function renderRecallBlock(
  memories: RenderableMemory[] | undefined,
  maxChars: number,
): string {
  if (!memories || memories.length === 0) return '';

  const header = 'Relevant memories (shodh):';
  let text = header;
  let used = 0;

  for (const memory of memories) {
    const line = memoryLine(memory, RECALL_LINE_MAX_CHARS);
    // +1 for the newline joining this line to the block.
    if (used + line.length + 1 > maxChars - header.length) break;
    text += `\n${line}`;
    used += line.length + 1;
  }

  return used === 0 ? '' : text;
}

/**
 * Render search results for a tool response or a slash command.
 *
 * Uncapped by default, on purpose. This output was requested — `limit` already
 * bounds how many memories arrive, so bounding their text too would leave the
 * model holding ids it cannot read. Only cap it when a caller needs a fixed
 * display budget (see `tools.searchResultMaxChars`).
 *
 * @param memories - normalized memories.
 * @param maxChars - per-memory cap; `0` (the default) renders full text.
 * @returns the rendered list, or a no-results notice.
 */
export function renderResults(memories: RenderableMemory[] | undefined, maxChars = 0): string {
  if (!memories || memories.length === 0) return 'No matching memories.';
  return memories
    .map((m) => {
      const id = m.id ? ` (${m.id})` : '';
      return `${memoryLine(m, maxChars)}${id}`;
    })
    .join('\n');
}

/**
 * Reduce a blob of prompt text to something worth sending as a query.
 *
 * Fenced code blocks and long pasted logs dominate the literal text but carry
 * little retrieval signal, and they inflate the embedding cost. They are stripped
 * before the text reaches shodh.
 *
 * @param text - the raw prompt.
 * @param maxChars - cap applied after cleaning.
 * @returns the cleaned query text.
 */
export function toQueryText(text: string, maxChars: number): string {
  if (!text) return '';
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`\n]{80,})`/g, ' ') // long inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading markers
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}
