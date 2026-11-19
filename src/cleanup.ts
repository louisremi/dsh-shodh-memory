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
  'stored memories as one line each: `id [Type NN%] #tags | text`, newest first',
  '(NN% is the importance the server assigned). A `(truncated)` or `(cut)` marker',
  'means you are NOT seeing the whole text: never include such a memory in a',
  'merge (its unseen part would be lost); you may still propose deleting it.',
  '',
  'Propose the smallest set of edits that removes duplication and staleness:',
  '- "merge": two or more memories say (nearly) the same thing, or several belong',
  '  in one consolidated statement. Provide `text` = the consolidated replacement.',
  '  The plugin keeps whichever merged memory the store has reinforced most and',
  '  rewrites it with `text`, so `text` must stand alone. `into` is optional and',
  '  only breaks ties. Prefer merging 2-4 closely related memories; never merge',
  '  across unrelated topics.',
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

/**
 * Per-memory cap inside the analysis input. A memory cut here is still shown
 * (it can be proposed for deletion) but is marked `(cut)` and can never be
 * part of a merge: the merge text would replace words the model never read.
 */
const LINE_CAP = 1200;

/** How long a report stays applicable. Past this the store has likely moved on. */
export const CLEANUP_REPORT_TTL_MS = 30 * 60 * 1000;

/** Abort reason when the cleanup budget expires. */
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

  // One budget for the whole pass: listing, full-text fetches, and the model.
  const deadline = newDeadline(signal, cfg.cleanup.timeoutMs);
  try {
    // ── inventory ────────────────────────────────────────────────────────────
    const { items, scanned, total } = await collectMemories(client, cfg, tenant, deadline.signal);
    if (items === null) {
      return errorText(
        'the shodh server does not expose the memory list endpoint (`POST /api/memories`); ' +
          'the circuit may also be open. Check `/shodh status`, then retry.',
      );
    }
    if (scanned === 0) {
      return `Cleanup found nothing to analyze: tenant \`${tenant}\` has no memories.`;
    }

    // Full text for truncated previews, newest first (the corpus keeps the
    // newest, so those are the fetches that matter). One concurrent GET per
    // item, at most `maxFetches`. Any item left truncated stays merge-ineligible.
    const truncated = items
      .filter((item) => item.truncated && item.id)
      .slice(0, cfg.cleanup.maxFetches);
    await Promise.all(truncated.map((item) => fillOne(client, item, tenant, deadline.signal)));

    // ── one-shot LLM pass ────────────────────────────────────────────────────
    const { corpus, dropped, seenIds, fullIds } = renderCorpus(items, cfg.cleanup.maxInputBytes);
    const text = await askLlm(deps, route, corpus, deadline.signal);
    const proposals = parseProposals(text).filter((p) => proposalAllowed(p, seenIds, fullIds));
    await chooseKeepers(client, tenant, proposals, items, deadline.signal);
    const report: CleanupReport = {
      tenant,
      proposals,
      seenIds,
      fullIds,
      created: Date.now(),
      applied: new Set(),
    };
    deps.state.cleanupReports.set(tenant, report);
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
 * Execute selected proposals from this tenant's last report. Human-confirmed only.
 *
 * @param deps - the same injected dependencies as {@link runCleanup}.
 * @param tenant - the caller's resolved tenant; only its own report is applied.
 * @param spec - `all`, or a comma-separated list of proposal numbers.
 * @param signal - caller cancellation, when the harness provides one.
 * @returns one result line per executed operation, plus a summary.
 */
export async function applyCleanup(
  deps: CleanupDeps,
  tenant: string,
  spec: string,
  signal?: AbortSignal,
): Promise<string> {
  const report = deps.state.cleanupReports.get(tenant);
  if (!report || report.proposals.length === 0) {
    return errorText(
      `nothing to apply for tenant \`${tenant}\`: run \`/shodh cleanup\` first to get a proposal report.`,
    );
  }
  if (Date.now() - report.created > CLEANUP_REPORT_TTL_MS) {
    deps.state.cleanupReports.delete(tenant);
    return errorText(
      `the last report is older than ${CLEANUP_REPORT_TTL_MS / 60_000} minutes and the store ` +
        'may have changed since. Run `/shodh cleanup` again.',
    );
  }
  const selection = parseSelection(spec, report.proposals.length);
  if ('error' in selection) return errorText(selection.error);

  const pending = selection.indexes.filter((index) => !report.applied.has(index));
  const already = selection.indexes.filter((index) => report.applied.has(index));

  // One budget for the whole apply, like the analysis pass.
  const deadline = newDeadline(signal, deps.cfg.cleanup.timeoutMs);
  const options = { userId: tenant, timeoutMs: 8000, signal: deadline.signal };
  const lines: string[] = already.map((index) => `#${index + 1} already applied — skipped`);
  let done = 0;
  let failed = 0;

  try {
    for (const [position, index] of pending.entries()) {
      if (deadline.signal.aborted) {
        const reason = deadline.signal.reason === CLEANUP_TIMEOUT ? 'timed out' : 'cancelled';
        lines.push(`${reason} — ${pending.length - position} proposal(s) not attempted`);
        break;
      }
      const proposal = report.proposals[index];
      // Re-check against the report's own record of what the model saw. The
      // report is long-lived state; nothing may mint entries into it.
      if (!proposalAllowed(proposal, report.seenIds, report.fullIds)) {
        failed += 1;
        lines.push(`#${index + 1} skipped — names memories the analysis did not see in full`);
        continue;
      }

      try {
        if (proposal.op === 'merge' && proposal.into && proposal.text) {
          await deps.client.updateMemory(proposal.into, proposal.text, options);
          lines.push(`#${index + 1} merged ${proposal.ids.length} → ${proposal.into}`);
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
          // Left retryable on purpose: re-applying re-sends the same rewrite
          // (harmless) and retries only what is still there.
          failed += 1;
          lines.push(
            `     WARNING could not delete ${missed.join(', ')} — ` +
              (proposal.op === 'merge'
                ? 'the consolidated copy coexists with these originals'
                : 'this memory is still in the store') +
              `; \`/shodh cleanup apply ${index + 1}\` retries it`,
          );
        } else {
          // Fully done: re-applying it later is a no-op.
          report.applied.add(index);
        }
        done += 1;
      } catch (error) {
        if (deadline.signal.aborted) {
          const reason = deadline.signal.reason === CLEANUP_TIMEOUT ? 'timed out' : 'cancelled';
          lines.push(
            `#${index + 1} ${reason} mid-way — check it with /shodh search; ` +
              `${pending.length - position - 1} proposal(s) not attempted`,
          );
          failed += 1;
          break;
        }
        failed += 1;
        lines.push(`#${index + 1} failed — ${describeError(error)}`);
      }
    }
  } finally {
    deadline.dispose();
  }

  lines.unshift(`Applied ${done} proposal(s), ${failed} problem(s):`);
  return lines.join('\n');
}

/**
 * Pick which memory each merge keeps. The model's `into` is ignored on purpose.
 *
 * A merge rewrites one memory in place (`PUT` replaces its text and keeps its
 * id, importance, and access count) and deletes the rest, together with
 * everything shodh learned about them. So the survivor must be the memory
 * shodh has reinforced the most: highest `importance` (which recalls and
 * feedback raise), then highest `access_count`. Remaining ties keep the
 * model's order, which puts its own pick first.
 *
 * `importance` comes with the list; `access_count` does not, so it is read
 * with one GET per merged memory. A failed read counts as unknown, never as a
 * reason to drop the proposal.
 *
 * @param proposals - the report's proposals; each merge's `into` is set in place.
 * @param items - the scanned memories, for their `importance`.
 */
async function chooseKeepers(
  client: ShodhClient,
  tenant: string,
  proposals: CleanupProposal[],
  items: ListMemoryItem[],
  signal: AbortSignal,
): Promise<void> {
  const merges = proposals.filter((p) => p.op === 'merge');
  if (merges.length === 0) return;

  const importance = new Map(items.map((m) => [m.id, m.importance]));
  const ids = [...new Set(merges.flatMap((p) => p.ids))];
  const accessCounts = new Map<string, number>();
  await Promise.all(
    ids.map(async (id) => {
      const full = await client
        .getMemory(id, { userId: tenant, timeoutMs: 5000, signal })
        .catch((error: unknown) => {
          if (signal.aborted) throw error;
          return undefined;
        });
      const count = full?.access_count ?? full?.accessCount;
      if (typeof count === 'number' && Number.isFinite(count)) accessCounts.set(id, count);
    }),
  );

  for (const proposal of merges) {
    proposal.into = rankKeepers(proposal.ids, importance, accessCounts)[0];
  }
}

/**
 * Order merge candidates best-kept first: importance, then access count (an
 * unknown count ranks below any known one), then the given order.
 */
export function rankKeepers(
  ids: string[],
  importance: Map<string, number>,
  accessCounts: Map<string, number>,
): string[] {
  return ids
    .map((id, order) => ({
      id,
      order,
      importance: importance.get(id) ?? 0,
      accesses: accessCounts.get(id) ?? -1,
    }))
    .sort((a, b) => b.importance - a.importance || b.accesses - a.accesses || a.order - b.order)
    .map((candidate) => candidate.id);
}

/**
 * Parse an apply selection. Strict: every token must be a proposal number in
 * range, so a typo can never silently apply a different subset.
 * @param spec - `all`, or comma/space-separated 1-based numbers.
 * @param count - how many proposals the report holds.
 * @returns zero-based indexes in ascending order, or an error sentence.
 */
export function parseSelection(
  spec: string,
  count: number,
): { indexes: number[] } | { error: string } {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase() === 'all') {
    return { indexes: Array.from({ length: count }, (_, i) => i) };
  }
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) {
    return { error: 'say which proposals: `/shodh cleanup apply <n,n,…>` (or `all`).' };
  }
  const bad = tokens.filter((t) => !/^\d+$/.test(t) || Number(t) < 1 || Number(t) > count);
  if (bad.length > 0) {
    return {
      error:
        `not a proposal number: ${bad.join(', ')}. The last report has ${count} ` +
        `proposal(s); use 1–${count}, or \`all\`. Nothing was applied.`,
    };
  }
  return { indexes: [...new Set(tokens.map((t) => Number(t) - 1))].sort((a, b) => a - b) };
}

/**
 * Whether a proposal may be executed: a delete needs every id to have been in
 * the analysis input; a merge needs every id's *whole* text there, because it
 * rewrites one and deletes the rest.
 */
function proposalAllowed(
  proposal: CleanupProposal,
  seenIds: Set<string>,
  fullIds: Set<string>,
): boolean {
  if (proposal.ids.length === 0) return false;
  if (proposal.op === 'merge') {
    const { into, text } = proposal;
    if (!into || !text || !proposal.ids.includes(into)) return false;
  }
  const allowed = proposal.op === 'merge' ? fullIds : seenIds;
  return proposal.ids.every((id) => allowed.has(id));
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
  signal: AbortSignal,
): Promise<{ items: ListMemoryItem[] | null; scanned: number; total: number }> {
  const cap = cfg.cleanup.maxMemories;
  const pageSize = Math.min(cap, 100);
  const options = { userId: tenant, timeoutMs: 10000, signal };
  const items: ListMemoryItem[] = [];
  let total = 0;

  for (let offset = 0; offset < cap; offset += pageSize) {
    const limit = Math.min(pageSize, cap - offset);
    let response: JsonRecord | undefined;
    try {
      response = await client.listMemories({ limit, offset }, options);
    } catch (error) {
      // Our own deadline or the caller: let runCleanup report it as such.
      if (signal.aborted) throw error;
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

/**
 * Replace one truncated preview with its full text, read from the analyzed
 * tenant's store. A failed fetch keeps the preview (and the item stays
 * merge-ineligible); running out of budget aborts the whole pass.
 */
async function fillOne(
  client: ShodhClient,
  item: ListMemoryItem,
  tenant: string,
  signal: AbortSignal,
): Promise<void> {
  const full = await client
    .getMemory(item.id, { userId: tenant, timeoutMs: 5000, signal })
    .catch((error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    });
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

/** What {@link renderCorpus} produced, and exactly what the model will have seen. */
export interface Corpus {
  /** The analysis input, newest memory first. */
  corpus: string;
  /** How many of the oldest memories did not fit the byte budget. */
  dropped: number;
  /** Ids present in the corpus (a delete may name these). */
  seenIds: Set<string>;
  /** Ids present with their whole text (a merge may only name these). */
  fullIds: Set<string>;
}

/**
 * The analysis input: one line per memory, newest first. Lines over
 * {@link LINE_CAP} are cut and marked `(cut)`; server previews that were never
 * filled are marked `(truncated)`. Lines are taken newest-first until the byte
 * budget is spent, so it is the *oldest* memories that fall off.
 * @param items - memories, newest first (the list endpoint's order).
 * @param maxInputBytes - UTF-8 budget for the joined corpus.
 */
export function renderCorpus(items: ListMemoryItem[], maxInputBytes: number): Corpus {
  const kept: string[] = [];
  const seenIds = new Set<string>();
  const fullIds = new Set<string>();
  let bytes = 0;

  for (const m of items) {
    const flat = m.content.replace(/\s+/g, ' ').trim();
    const cut = flat.length > LINE_CAP;
    const body = cut ? `${flat.slice(0, LINE_CAP - 1).trimEnd()}…` : flat;
    const tags = m.tags.length > 0 ? ` #${m.tags.join(' #')}` : '';
    const marker = m.truncated ? ' (truncated)' : cut ? ' (cut)' : '';
    const importance = Math.round(Math.min(1, Math.max(0, m.importance)) * 100);
    const line = `${m.id} [${m.type} ${importance}%]${tags}${marker} | ${body}`;

    // Each line after the first also pays for its joining newline. The first
    // line always goes in, so a tiny budget still analyzes something.
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && bytes + cost > maxInputBytes) break;
    kept.push(line);
    bytes += cost;
    seenIds.add(m.id);
    if (!m.truncated && !cut) fullIds.add(m.id);
  }

  return { corpus: kept.join('\n'), dropped: items.length - kept.length, seenIds, fullIds };
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
    // The model's `into` is a hint only: it moves to the front of `ids`, so it
    // wins ties when the keeper is picked by reinforcement (see chooseKeepers).
    const hint = typeof item.into === 'string' && ids.includes(item.into) ? item.into : undefined;
    const unique = [...new Set(hint ? [hint, ...ids] : ids)];
    proposals.push({
      op,
      ids: unique,
      into: op === 'merge' ? unique[0] : undefined,
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
  if (scope.scanned < scope.total || scope.dropped > 0) {
    const parts: string[] = [];
    if (scope.scanned < scope.total) parts.push(`${scope.scanned}/${scope.total} newest scanned`);
    if (scope.dropped > 0) {
      parts.push(`${scope.dropped} oldest over the input budget, not analyzed`);
    }
    lines.push(`scope     ${parts.join(' · ')}`);
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
    for (const id of proposal.ids) {
      const role =
        proposal.op === 'merge'
          ? id === proposal.into
            ? '  (kept: most reinforced)'
            : '  (deleted)'
          : '';
      lines.push(`   - ${id}${role}`);
    }
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
