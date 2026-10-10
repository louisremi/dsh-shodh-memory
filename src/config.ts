/**
 * Config normalization.
 *
 * Cordis validates a plugin's config only when the runtime exports a `Config`
 * schema. This plugin deliberately ships none — pulling `@deepseek-ai/schemastery`
 * in for one document is not worth the dependency — so every field is normalized
 * and clamped here instead. Unknown keys are ignored rather than fatal: a user
 * overriding one layer of this config should never be able to stop the harness
 * from booting.
 *
 * @module config
 */

import type { ShodhConfig } from './types.js';

/** Hard ceilings that keep a mistyped config from producing an unbounded prompt. */
const LIMITS = {
  maxChars: 8000,
  maxResults: 20,
  queryChars: 4000,
  captureMaxChars: 8000,
  searchResultMaxChars: 8000,
  requestTimeoutMs: 30000,
  recallTimeoutMs: 10000,
  captureTimeoutMs: 30000,
};

/** @returns `value` when it is a finite number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** @returns `value` clamped into `[min, max]`, falling back to `fallback`. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = num(value, fallback);
  return Math.min(max, Math.max(min, n));
}

/** @returns `value` when it is a non-empty string, else `fallback`. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** @returns `value` when it is a boolean, else `fallback`. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Merge one partial object over defaults and normalize every field.
 * @param raw - the user's (possibly absent) section.
 * @param spec - per-field normalizers keyed by field name.
 * @returns the fully populated section.
 */
function section<S extends Record<string, (value: unknown) => unknown>>(
  raw: unknown,
  spec: S,
): { [K in keyof S]: ReturnType<S[K]> } {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, normalize] of Object.entries(spec)) out[key] = normalize(source[key]);
  return out as { [K in keyof S]: ReturnType<S[K]> };
}

/**
 * Normalize the raw bundle config into the complete runtime shape.
 * @param raw - the `config` block from the `cordis.patch.yml` row.
 * @returns every field populated, clamped, and safe to read without guards.
 */
export function normalizeConfig(raw: unknown): ShodhConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  return {
    baseUrl: str(source.baseUrl, 'http://127.0.0.1:3030').replace(/\/+$/, ''),
    apiKeyEnv: str(source.apiKeyEnv, 'SHODH_API_KEY'),
    apiKey:
      typeof source.apiKey === 'string' && source.apiKey.length > 0 ? source.apiKey : undefined,
    userId: str(source.userId, 'dsh'),
    userIdScope: source.userIdScope === 'workspace' ? 'workspace' : 'global',

    requestTimeoutMs: clamp(source.requestTimeoutMs, 100, LIMITS.requestTimeoutMs, 3000),
    recallTimeoutMs: clamp(source.recallTimeoutMs, 100, LIMITS.recallTimeoutMs, 1500),
    captureTimeoutMs: clamp(source.captureTimeoutMs, 100, LIMITS.captureTimeoutMs, 4000),
    failureThreshold: clamp(source.failureThreshold, 1, 20, 3),
    failureCooldownMs: clamp(source.failureCooldownMs, 1000, 600000, 30000),

    tools: section(source.tools, {
      save: (v) => bool(v, true),
      search: (v) => bool(v, true),
      forget: (v) => bool(v, true),
      // Per-memory cap on `memory_search` output. 0 = full text, the default:
      // these results were requested and `limit` already bounds them. Raise it
      // only if a deployment wants a hard display budget.
      searchResultMaxChars: (v) => clamp(v, 0, LIMITS.searchResultMaxChars, 0),
    }),

    autoRecall: section(source.autoRecall, {
      enabled: (v) => bool(v, true),
      maxChars: (v) => clamp(v, 100, LIMITS.maxChars, 1200),
      maxResults: (v) => clamp(v, 1, LIMITS.maxResults, 5),
      minPromptChars: (v) => clamp(v, 0, 1000, 12),
      reuseGapTurns: (v) => clamp(v, 0, 1000, 8),
      queryChars: (v) => clamp(v, 32, LIMITS.queryChars, 500),
    }),

    autoCapture: section(source.autoCapture, {
      enabled: (v) => bool(v, true),
      userPrompts: (v) => bool(v, true),
      toolErrors: (v) => bool(v, true),
      assistantReplies: (v) => bool(v, false),
      maxChars: (v) => clamp(v, 64, LIMITS.captureMaxChars, 900),
      minChars: (v) => clamp(v, 0, 4000, 24),
    }),

    promptSection: bool(source.promptSection, true),
  };
}

/** The memory types shodh weights, ordered by importance contribution. */
export const MEMORY_TYPES: string[] = [
  'Decision',
  'Learning',
  'Error',
  'Discovery',
  'Pattern',
  'Task',
  'Context',
  'Conversation',
  'Observation',
];
