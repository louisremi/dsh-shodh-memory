/**
 * On-demand memory cleanup: one LLM pass over the stored memories that
 * proposes merges of near-duplicates and deletions of stale records.
 *
 * Two design decisions carry the whole module:
 *
 * 1. **Opt-in only, never background.** The plugin's selling point is that it
 *    costs zero model tokens on every turn. This pass spends real tokens, so it
 *    runs exclusively when a human types `/shodh cleanup` — once, bounded,
 *    visible. Nothing here ever wakes up by itself.
 *
 * 2. **Propose, never apply.** The LLM sees stored text and nothing else. It
 *    cannot verify a fact against the live system, and it may hallucinate an
 *    id, so its output is a report. `/shodh cleanup apply 1,3` executes the
 *    chosen proposals — and only ids that report actually proposed, and only
 *    memories the analysis actually saw, get touched.
 *
 * The LLM call mirrors upstream's one-shot pattern (dsh-session-title-llm):
 * `ctx.llm.prepareCall(route)` → dispatch with the *prepared* config spread
 * into the request → assemble chunks → read the finish reason. The call-config
 * fields of the request must match the prepared config exactly, or the runtime
 * rejects the dispatch.
 *
 * @module cleanup
 */

import type { ShodhClient, ShodhError as ShodhErrorType } from './client.js';
import type {
  BlockAssemblerCtor,
  CleanupProposal,
  CleanupReport,
  CreateUserMessage,
  JsonRecord,
  JsonValue,
  ListMemoryItem,
  PluginState,
  ShodhConfig,
  ShodhContext,
} from './types.js';

/** Everything runCleanup needs, all injected — no ambient host access. */
export interface CleanupDeps {
  /** The cordis context; `ctx.llm` is read at call time, never captured. */
  ctx: ShodhContext;
  /** A {@link ShodhClient}. */
  client: ShodhClient;
  /** Normalized config (the `cleanup` section drives the bounds). */
  cfg: ShodhConfig;
  /** Shared plugin state; the report is stored on it for `apply`. */
  state: PluginState;
  /** The `createUserMessage` factory, when `@deepseek-ai/dsh-llm` loaded. */
  createUserMessage?: CreateUserMessage;
  /** The `BlockAssembler` class, when `@deepseek-ai/dsh-llm` loaded. */
  BlockAssembler?: BlockAssemblerCtor;
}

/** The assembled one-shot request. Structural: it carries live objects, so not a JsonRecord. */
interface RequestOptions {
  [key: string]: unknown;
}

/** System prompt for the analysis. The output contract is JSONL, one proposal per line. */
const SYSTEM_PROMPT = [
  'You maintain a long-term memory store for an AI coding harness. You receive the',
  'stored memories as one line each: `id [Type NN%] #tags | text` (NN% is the',
  'importance the server assigned; a `(truncated)` marker means the text was cut at',
  '500 characters — be conservative about proposing merges of those).',
  '',
  'Propose the smallest set of edits that removes duplication and staleness:',
  '- "merge": two or more memories say (nearly) the same thing, or several belong',
  '  in one consolidated statement. Provide `into` = the id worth keeping, `text`',
  '  = the consolidated replacement written for the kept memory. Prefer merging',
  '  2-4 closely related memories; never merge across unrelated topics.',
  '- "delete": the memory is obsolete or superseded by another listed memory and',
  '  keeping it would mislead. Prefer merge/delete over delete when a correction',
  '  exists; keep memories about durable environment facts.',
  '',
  'Rules: use ONLY ids that appear in the input. Never propose an edit for',
  'well-formed unique memories. Rationale in one short sentence, no line breaks.',
  'Do not invent facts: `text` may only restate, condense, or reconcile what the',
  'input memories already say. When nothing deserves an edit, output nothing.',
  '',
  'Output ONLY JSONL — one JSON object per line, no prose, no code fences:',
  '{"op":"merge","ids":["id1","id2"],"into":"id1","text":"…","reason":"…"}',
  '{"op":"delete","ids":["id3"],"reason":"…"}',
].join('\n');

/** Per-memory line cap inside the analysis input. The report shows more; this is the model's index view. */
const LINE_CAP = 300;

/** Timeout code when the cleanup budget expires. */
const CLEANUP_TIMEOUT = new Error('shodh-memory: cleanup timed out');

/**
 * Run the analysis pass and render the proposal report.
 *
 * @param deps - injected dependencies.
 * @param tenant - the resolved shodh tenant to analyze.
 * @param signal - caller cancellation, when the harness provides one.
 * @returns the report text; proposals are also stored on `state` for `apply`.
 */
export async function runCleanup(
  deps: CleanupDeps,
  tenant: string,
  signal?: AbortSignal,
): Promise<string> {
  const { ctx, client, cfg } = deps;

  const llm = ctx.llm;
  if (!llm) return errorText('no LLM service is available in this profile, so cleanup cannot run.');
  if (!deps.createUserMessage || !deps.BlockAssembler) {
    return errorText('@deepseek-ai/dsh-llm is unavailable, so cleanup cannot run.');
  }
  const route = await resolveRoute(llm, cfg);
  if (!route) return errorText('no LLM provider is registered, so cleanup cannot run.');

  // ── inventory ──────────────────────────────────────────────────────────────
  const { items, scanned, total } = await collectMemories(client, cfg, tenant);
  if (items === null) {
    return errorText(
      'the shodh server does not expose the memory list endpoint (`POST /api/memories`); ' +
        'the circuit may also be open. Check `/shodh status`, then retry.',
    );
  }
  if (scanned === 0) {
    return `Cleanup found nothing to analyze: tenant \`${tenant}\` has no memories.`;
  }

  // Full text for truncated items: one concurrent GET per item — the page we
  // just fetched bounds the concurrency — and at most `maxFetches` items are
  // upgraded, oldest-first, since the corpus drops oldest lines anyway.
  const truncated = items
    .filter((item) => item.truncated && item.id)
    .slice(0, cfg.cleanup.maxFetches);
  await Promise.all(truncated.map((item) => fillOne(client, item)));

  // ── one-shot LLM pass ──────────────────────────────────────────────────────
  const { corpus, dropped } = renderCorpus(items, cfg.cleanup.maxInputBytes);
  const deadline = newDeadline(signal, cfg.cleanup.timeoutMs);
  try {
    const text = await askLlm(deps, route, corpus, deadline.signal);
    const proposals = parseProposals(text).filter(
      (p) => p.ids.length > 0 && p.ids.every((id) => items.some((m) => m.id === id)),
    );
    const report: CleanupReport = {
      tenant,
      proposals,
      knownIds: new Set(items.map((m) => m.id)),
      created: Date.now(),
    };
    deps.state.cleanupProposals = report;
    return renderCleanupReport(report, { scanned, total, dropped });
  } catch (reason) {
    const message =
      reason === CLEANUP_TIMEOUT
        ? `cleanup timed out after ${Math.round(cfg.cleanup.timeoutMs / 1000)}s`
        : describeError(reason);
    return errorText(`${message}; nothing was changed.`);
  } finally {
    deadline.dispose();
  }
}

/**
 * Execute selected proposals from the last report. Human-confirmed only.
 *
 * @param deps - the same injected dependencies as {@link runCleanup}.
 * @param spec - `all`, or a comma-separated list of proposal numbers.
 * @param signal - caller cancellation, when the harness provides one.
 * @returns one result line per executed operation, plus a summary.
 */
export async function applyCleanup(
  deps: CleanupDeps,
  spec: string,
  signal?: AbortSignal,
): Promise<string> {
  const report = deps.state.cleanupProposals;
  if (!report || report.proposals.length === 0) {
    return errorText('nothing to apply: run `/shodh cleanup` first to get a proposal report.');
  }
  const picked =
    spec.toLowerCase() === 'all'
      ? report.proposals.map((_, i) => i)
      : spec
          .split(',')
          .map((part) => Number(part.trim()) - 1)
          .filter((n) => Number.isInteger(n) && n >= 0 && n < report.proposals.length);
  if (picked.length === 0) {
    return errorText('Usage: `/shodh cleanup apply <n,n,…>` (or `all`) — after `/shodh cleanup`.');
  }

  const options = { userId: report.tenant, timeoutMs: 8000 };
  const lines: string[] = [];
  let done = 0;
  let failed = 0;

  for (const index of [...new Set(picked)].sort((a, b) => a - b)) {
    if (signal?.aborted) {
      lines.push(`cancelled — ${picked.length - lines.length} proposal(s) not attempted`);
      break;
    }
    const proposal = report.proposals[index];
    // The report was built from ids we fetched, but a report is long-lived state
    // and nothing else may mint entries into it: unknown ids are refused.
    const unknown = proposal.ids.filter((id) => !report.knownIds.has(id));
    if (unknown.length > 0) {
      failed += 1;
      lines.push(`#${index + 1} skipped — unknown id(s): ${unknown.join(', ')}`);
      continue;
    }

    try {
      if (proposal.op === 'merge' && proposal.into && proposal.text) {
        await deps.client.updateMemory(proposal.into, proposal.text, options);
        lines.push(`#${index + 1} merged ${proposal.ids.length} → ${proposal.into}`);
      } else if (proposal.op === 'merge' && proposal.text) {
        const created = await deps.client.remember(
          { content: proposal.text, memoryType: 'Decision' },
          options,
        );
        const keepId = typeof created?.id === 'string' ? created.id : undefined;
        lines.push(
          `#${index + 1} merged ${proposal.ids.length} → new${keepId ? ` ${keepId}` : ''}`,
        );
        proposal.into = keepId;
      } else {
        lines.push(`#${index + 1} deleted ${proposal.ids.length}`);
      }
      const rest = proposal.ids.filter((id) => id !== proposal.into);
      const forgotten: string[] = [];
      const missed: string[] = [];
      for (const id of rest) {
        if (await forgetQuiet(deps.client, id, options)) forgotten.push(id);
        else missed.push(id);
      }
      if (forgotten.length > 0) lines.push(`     forgot ${forgotten.join(', ')}`);
      if (missed.length > 0) {
        failed += 1;
        lines.push(
          `     WARNING could not delete ${missed.join(', ')} — ` +
            (proposal.op === 'merge'
              ? 'the consolidated copy coexists with these originals'
              : 'this memory is still in the store'),
        );
      }
      done += 1;
    } catch (error) {
      failed += 1;
      lines.push(`#${index + 1} failed — ${describeError(error)}`);
    }
  }

  lines.unshift(`Applied ${done} proposal(s), ${failed} problem(s):`);
  return lines.join('\n');
}

// ── inventory ────────────────────────────────────────────────────────────────

/**
 * Page the newest memories via `POST /api/memories`.
 * @returns the collected items (possibly fewer than `total`, newest-first),
 * or `items: null` when the endpoint itself failed (old server, breaker open).
 */
async function collectMemories(
  client: ShodhClient,
  cfg: ShodhConfig,
  tenant: string,
): Promise<{ items: ListMemoryItem[] | null; scanned: number; total: number }> {
  const cap = cfg.cleanup.maxMemories;
  const pageSize = Math.min(cap, 100);
  const options = { userId: tenant, timeoutMs: 10000 };
  const items: ListMemoryItem[] = [];
  let total = 0;

  for (let offset = 0; offset < cap; offset += pageSize) {
    const limit = Math.min(pageSize, cap - offset);
    let response: JsonRecord | undefined;
    try {
      response = await client.listMemories({ limit, offset }, options);
    } catch (error) {
      // A 404/405 is not an outage: the deployed server simply predates the
      // list endpoint, and paging on would just repeat the same rejection.
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 405) return { items: null, scanned: 0, total: 0 };
      // First page failing (outage, breaker) means nothing to analyze yet;
      // later pages failing just truncates the scan we already have.
      if (offset === 0) return { items: null, scanned: 0, total: 0 };
      deps_debug(client, error);
      break;
    }
    const raw = Array.isArray(response?.memories)
      ? (response?.memories as JsonValue[])
      : Array.isArray(response)
        ? (response as unknown as JsonValue[])
        : null;
    if (raw === null) {
      if (offset === 0) return { items: null, scanned: 0, total: 0 };
      break;
    }
    total = typeof response?.total === 'number' ? response.total : items.length;
    for (const entry of raw) items.push(normalizeListItem(entry));
    if (raw.length < limit || items.length >= total) break;
  }
  return { items, scanned: items.length, total };
}

/** Normalize one list item, tolerating snake_case and camelCase servers. */
function normalizeListItem(raw: unknown): ListMemoryItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const experience = (
    record.experience && typeof record.experience === 'object' ? record.experience : {}
  ) as Record<string, unknown>;
  const string = (...values: unknown[]): string => {
    for (const value of values) if (typeof value === 'string') return value;
    return '';
  };
  const number = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const truncatedFlag = record.content_truncated ?? record.contentTruncated;
  return {
    id: string(record.id, experience.id),
    content: string(record.content, experience.content),
    truncated: truncatedFlag === true,
    length: number(record.content_length, record.contentLength),
    type: string(record.memory_type, record.memoryType, experience.memory_type) || 'Observation',
    importance: number(record.importance) ?? 0,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

/** Replace one truncated preview with its full text; any failure keeps the preview. */
async function fillOne(client: ShodhClient, item: ListMemoryItem): Promise<void> {
  const full = await client
    .getMemory(item.id, { userId: client.userId, timeoutMs: 5000 })
    .catch(() => undefined);
  const content = full && typeof full.content === 'string' ? full.content : undefined;
  if (content) {
    item.content = content;
    item.truncated = false;
  }
}

// ── the LLM pass ─────────────────────────────────────────────────────────────

/** Resolve the route: explicit config pair, else first provider's first model. */
async function resolveRoute(
  llm: NonNullable<ShodhContext['llm']>,
  cfg: ShodhConfig,
): Promise<{ provider: string; model: string } | undefined> {
  const { provider, model } = cfg.cleanup;
  if (provider !== undefined && model !== undefined) return { provider, model };
  const first = llm.listProviders()[0];
  if (!first) return undefined;
  const models = await llm.listModels(first.id);
  const modelId = models[0]?.id;
  return modelId === undefined ? undefined : { provider: first.id, model: modelId };
}

/**
 * The analysis input: one capped line per memory, oldest dropped first until
 * the byte budget fits (newest memories are the most relevant to prune).
 */
export function renderCorpus(
  items: ListMemoryItem[],
  maxInputBytes: number,
): { corpus: string; dropped: number } {
  const lines = items.map((m) => {
    const flat = m.content.replace(/\s+/g, ' ').trim();
    const body = flat.length > LINE_CAP ? `${flat.slice(0, LINE_CAP - 1).trimEnd()}…` : flat;
    const tags = m.tags.length > 0 ? ` #${m.tags.join(' #')}` : '';
    const cut = m.truncated ? ' (truncated)' : '';
    return `${m.id} [${m.type} ${Math.round(Math.min(1, Math.max(0, m.importance)) * 100)}%]${tags}${cut} | ${body}`;
  });

  let dropped = 0;
  // `Buffer.byteLength` is exactly what the API charges for; join cost is the
  // newlines, recomputed cheaply as length of the joined body + (count - 1).
  for (;;) {
    const kept = lines.slice(dropped);
    const bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, -1);
    if (bytes <= maxInputBytes || kept.length <= 1) {
      return { corpus: kept.join('\n'), dropped };
    }
    dropped += 1;
  }
}

/**
 * One prepared one-shot LLM call. Mirrors upstream's session-title-llm:
 * request config = prepared config, spread verbatim.
 */
async function askLlm(
  deps: CleanupDeps,
  route: { provider: string; model: string },
  corpus: string,
  signal: AbortSignal,
): Promise<string> {
  const { ctx, cfg } = deps;
  const llm = ctx.llm;
  if (!llm || !deps.createUserMessage || !deps.BlockAssembler) {
    throw new Error('cleanup is unavailable');
  }
  const call = await llm.prepareCall({ ...route, maxTokens: cfg.cleanup.maxOutputTokens }, signal);
  const message = deps.createUserMessage({
    content: [{ type: 'text', text: `Stored memories to analyze:\n\n${corpus}` }],
    source: {
      kind: 'plugin:shodh-memory',
      form: 'notice',
      summary: 'shodh memory cleanup analysis',
    },
  });
  const options: RequestOptions = {
    ...call.config,
    messages: [message],
    system: SYSTEM_PROMPT,
    purpose: 'shodh-cleanup',
    signal,
  };
  const assembler = new deps.BlockAssembler();
  for await (const chunk of call.stream(options)) {
    throwIfCancelled(signal);
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(finish.failure?.message ?? `model call ${finish.kind ?? 'failed'}`);
  }
  return collectedText(assembler);
}

/**
 * Assembled text. A real `BlockAssembler` exposes `blocks()`; anything without
 * it (a stub) still accumulated deltas via `push`, so fall back to that.
 */
function collectedText(assembler: InstanceType<BlockAssemblerCtor>): string {
  const withBlocks = assembler as { blocks?: () => unknown[] };
  if (typeof withBlocks.blocks === 'function') {
    return withBlocks
      .blocks()
      .map((block) =>
        block && typeof block === 'object' && (block as JsonRecord).type === 'text'
          ? String((block as JsonRecord).text ?? '')
          : '',
      )
      .join('');
  }
  const deltas = assembler as { textDeltas?: string[] };
  return Array.isArray(deltas.textDeltas) ? deltas.textDeltas.join('') : '';
}

/**
 * Parse the model's JSONL proposals. Tolerant by design: prose around the
 * lines, code fences, or a single pretty-printed array all still parse; lines
 * that are not valid proposal objects are skipped, never fatal.
 * @param text - the raw model output.
 * @returns proposals in output order.
 */
export function parseProposals(text: string): CleanupProposal[] {
  const records: unknown[] = [];
  const whole = text.trim();
  if (whole.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(whole);
      if (Array.isArray(parsed)) records.push(...parsed);
    } catch {
      /* fall through to line scanning */
    }
  }
  if (records.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^```[a-z]*$/i, '');
      if (!trimmed.startsWith('{')) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        /* prose or a truncated tail line — skip */
      }
    }
  }

  const proposals: CleanupProposal[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const item = record as Record<string, unknown>;
    const op = item.op === 'merge' || item.op === 'delete' ? item.op : undefined;
    if (!op) continue;
    const ids = Array.isArray(item.ids)
      ? item.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) continue;
    if (op === 'merge' && (typeof item.text !== 'string' || item.text.trim() === '')) continue;
    proposals.push({
      op,
      ids: [...new Set(ids)],
      into:
        typeof item.into === 'string' && ids.includes(item.into)
          ? item.into
          : op === 'merge'
            ? ids[0]
            : undefined,
      text: typeof item.text === 'string' ? item.text.trim() : undefined,
      reason: typeof item.reason === 'string' ? item.reason.trim() : undefined,
    });
  }
  return proposals;
}

// ── rendering ────────────────────────────────────────────────────────────────

/** The report header: a stable prefix, plus the tenant and the scan scope. */
export function cleanupReportHeader(report: CleanupReport, scanned: number): string {
  return `shodh cleanup  ${report.tenant}  ${scanned} memories scanned`;
}

/**
 * The human-facing report: numbered proposals grouped by operation, with the
 * scan scope spelled out so a partial scan is never mistaken for the store.
 */
export function renderCleanupReport(
  report: CleanupReport,
  scope: { scanned: number; total: number; dropped: number },
): string {
  const lines: string[] = [cleanupReportHeader(report, scope.scanned), '─'.repeat(44)];
  if (scope.scanned < scope.total) {
    lines.push(
      `scope     ${scope.scanned}/${scope.total} newest scanned` +
        (scope.dropped > 0 ? ` · ${scope.dropped} over the input budget` : ''),
    );
  }
  lines.push('');

  if (report.proposals.length === 0) {
    lines.push('No consolidation proposed — the scanned memories look consistent.');
    return lines.join('\n');
  }

  report.proposals.forEach((proposal, i) => {
    const n = i + 1;
    if (proposal.op === 'merge') {
      lines.push(`${n}. merge ${proposal.ids.length} memories → ${proposal.into ?? 'new memory'}`);
    } else {
      lines.push(`${n}. delete ${proposal.ids[0] ?? `${proposal.ids.length} memories`}`);
    }
    for (const id of proposal.ids) lines.push(`   - ${id}`);
    if (proposal.text) {
      const flat = proposal.text.replace(/\s+/g, ' ').trim();
      lines.push(`   + ${flat.length > 240 ? `${flat.slice(0, 239).trimEnd()}…` : flat}`);
    }
    if (proposal.reason) lines.push(`   = ${proposal.reason}`);
    lines.push('');
  });

  lines.push(`Review, then apply: /shodh cleanup apply <numbers> (or \`all\`)`);
  return lines.join('\n');
}

// ── small shared helpers ─────────────────────────────────────────────────────

/** DELETE one memory through the breaker-aware `soft` path. @returns whether the server confirmed. */
async function forgetQuiet(
  client: ShodhClient,
  id: string,
  options: { userId: string; timeoutMs: number },
): Promise<boolean> {
  const result: JsonRecord | undefined = await client.soft(
    `/api/memory/${encodeURIComponent(id)}?user_id=${encodeURIComponent(options.userId)}`,
    undefined,
    { method: 'DELETE', timeoutMs: options.timeoutMs },
  );
  return result !== undefined;
}

/** A uniform error line for every cleanup failure mode. */
function errorText(message: string): string {
  return `Cleanup unavailable: ${message}`;
}

/** Best-effort human sentence for an unknown thrown value. */
function describeError(reason: unknown): string {
  const error = reason as { message?: unknown; status?: unknown };
  const message = typeof error?.message === 'string' ? error.message : String(reason);
  const status = typeof error?.status === 'number' ? ` (HTTP ${error.status})` : '';
  return message.replace(/^shodh-memory:\s*/, '') + status;
}

/** Log a swallowed non-fatal list failure through the client's logger, if any. */
function deps_debug(client: ShodhClient, error: unknown): void {
  const err = error as { message?: unknown };
  (client as { logger?: { debug?(...args: unknown[]): void } }).logger?.debug?.(
    `[shodh-memory] cleanup list page failed, scanning what we have: ${String(err?.message ?? error)}`,
  );
}

/** Cancellation check for the chunk loop. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? CLEANUP_TIMEOUT;
}

/**
 * Own deadline: combine caller cancellation with the cleanup timeout on one
 * AbortController (a timeout is not a dependency; the util package upstream
 * uses is not a runtime dep here).
 */
function newDeadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(CLEANUP_TIMEOUT), timeoutMs);
  const onCallerAbort = () => controller.abort(caller?.reason ?? CLEANUP_TIMEOUT);
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener('abort', onCallerAbort);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

// `ShodhErrorType` is re-exported only for its documentation value above.
export type { ShodhErrorType };
