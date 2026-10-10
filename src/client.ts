/**
 * Minimal HTTP client for the shodh-memory REST API.
 *
 * Deliberately dependency-free: Node 18+ ships a global `fetch`, and a memory
 * plugin should not drag a transport library into the harness process.
 *
 * The one piece of real machinery here is the circuit breaker. This client is
 * called from inside the turn-critical path (auto-recall) and from background
 * capture, and the harness must keep working at full speed when the memory
 * server is down. So after `failureThreshold` consecutive failures the breaker
 * opens: every call returns a failure immediately, without touching the socket,
 * for `failureCooldownMs`. The next call after that is a probe; success closes
 * the breaker and resets the counter.
 *
 * @module client
 */

import type { CallOptions, JsonRecord, RememberInput, ShodhLogger } from './types.js';

/** Machine-readable failure tag. */
export type ShodhErrorCode = 'transport' | 'http' | 'parse' | 'open';

/** A shodh call that failed: transport error, non-2xx, or an open breaker. */
export class ShodhError extends Error {
  code: ShodhErrorCode;
  status?: number;

  /**
   * @param message - human-readable failure.
   * @param code - machine-readable tag: `transport` | `http` | `parse` | `open`.
   * @param status - HTTP status when one was received.
   */
  constructor(message: string, code: ShodhErrorCode, status?: number) {
    super(message);
    this.name = 'ShodhError';
    this.code = code;
    this.status = status;
  }
}

/** Connection and breaker settings for {@link ShodhClient}, already normalized. */
export interface ShodhClientOptions {
  /** shodh HTTP root, no trailing slash. */
  baseUrl: string;
  /** the `X-API-Key` value; empty or absent means unauthenticated. */
  apiKey?: string;
  /** shodh tenant namespace used for every call. */
  userId: string;
  /** default per-call budget. */
  requestTimeoutMs: number;
  /** consecutive failures that open the breaker. */
  failureThreshold: number;
  /** how long an open breaker refuses calls. */
  failureCooldownMs: number;
  /** cordis logger for breaker transitions. */
  logger?: ShodhLogger;
}

/** Parameters for {@link ShodhClient.recall}. */
export interface RecallInput {
  query: string;
  limit?: number;
  mode?: string;
  sessionId?: string;
}

/** Parameters for {@link ShodhClient.proactiveContext}. */
export interface ProactiveContextInput {
  context: string;
  maxResults?: number;
}

export class ShodhClient {
  baseUrl: string;
  apiKey: string;
  userId: string;
  requestTimeoutMs: number;
  failureThreshold: number;
  failureCooldownMs: number;
  logger?: ShodhLogger;

  consecutiveFailures = 0;
  openUntil = 0;
  lastError: ShodhError | undefined;

  /**
   * @param options - connection and breaker settings, already normalized.
   */
  constructor({
    baseUrl,
    apiKey,
    userId,
    requestTimeoutMs,
    failureThreshold,
    failureCooldownMs,
    logger,
  }: ShodhClientOptions) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey ?? '';
    this.userId = userId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.failureThreshold = failureThreshold;
    this.failureCooldownMs = failureCooldownMs;
    this.logger = logger;

    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastError = undefined;
  }

  /** Whether the breaker is currently refusing calls. */
  get breakerOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  /**
   * The tenant a call belongs to.
   *
   * `this.userId` is the process default — already workspace-scoped when
   * `userIdScope: 'workspace'`. A caller holding an agent may pass a more
   * specific tenant via `options.userId`; without one every call still lands in
   * the right namespace, which is what makes per-workspace memory work for
   * event-driven capture, where no agent is attached to the event.
   *
   * @param options - the call options, possibly carrying `userId`.
   * @returns the tenant id to send.
   */
  uid(options?: CallOptions): string {
    return options?.userId ?? this.userId;
  }

  /**
   * One REST call. Resolves the parsed JSON body or throws {@link ShodhError}.
   *
   * @param path - API path beginning with `/`, e.g. `/api/recall`.
   * @param body - JSON body for POST calls; omitted for GET/DELETE.
   * @param options - per-call overrides.
   * @returns the parsed JSON response body.
   */
  async call<T = JsonRecord>(
    path: string,
    body?: JsonRecord,
    { method = 'POST', timeoutMs }: CallOptions = {},
  ): Promise<T> {
    if (this.breakerOpen) {
      throw new ShodhError(
        `shodh-memory circuit open (retry in ${Math.ceil((this.openUntil - Date.now()) / 1000)}s)`,
        'open',
      );
    }

    const budget = timeoutMs ?? this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ShodhError(
          `shodh ${method} ${path} -> HTTP ${response.status}${detail ? `: ${truncate(detail, 200)}` : ''}`,
          'http',
          response.status,
        );
      }

      const text = await response.text();
      if (!text) {
        this.recordSuccess();
        return {} as T;
      }
      try {
        const parsed = JSON.parse(text);
        this.recordSuccess();
        return parsed;
      } catch {
        throw new ShodhError(
          `shodh ${method} ${path} returned non-JSON: ${truncate(text, 120)}`,
          'parse',
        );
      }
    } catch (error) {
      if (error instanceof ShodhError) {
        this.recordFailure(error);
        throw error;
      }
      const err = error as { name?: string; message?: unknown };
      const message =
        err?.name === 'AbortError' ? `timed out after ${budget}ms` : String(err?.message ?? error);
      const wrapped = new ShodhError(`shodh ${method} ${path} ${message}`, 'transport');
      this.recordFailure(wrapped);
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A call whose failure is expected and uninteresting: resolves `undefined`
   * instead of throwing. Used by every automatic path (recall, capture) so the
   * caller never needs a try/catch on the happy path.
   *
   * @param path - API path.
   * @param body - JSON body.
   * @param options - same as {@link call}.
   * @returns the parsed body, or `undefined` on any failure.
   */
  async soft<T = JsonRecord>(
    path: string,
    body?: JsonRecord,
    options?: CallOptions,
  ): Promise<T | undefined> {
    try {
      return await this.call<T>(path, body, options);
    } catch (error) {
      const err = error as { message?: unknown };
      this.logger?.debug?.(`[shodh-memory] ${String(err?.message ?? error)}`);
      return undefined;
    }
  }

  /** Reset the failure counter and close the breaker. */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0 || this.openUntil > 0) {
      this.logger?.info?.('[shodh-memory] recovered; circuit closed');
    }
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastError = undefined;
  }

  /**
   * Count a failure and open the breaker once enough pile up.
   * @param error - the failure being recorded.
   */
  recordFailure(error: ShodhError): void {
    this.lastError = error;
    // An already-open breaker must not re-arm on its own probe failure without
    // counting it, or a dead server would be probed on every single call.
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      const wasOpen = this.openUntil > Date.now();
      this.openUntil = Date.now() + this.failureCooldownMs;
      if (!wasOpen) {
        this.logger?.warn?.(
          `[shodh-memory] ${this.consecutiveFailures} consecutive failures, circuit open for ` +
            `${Math.round(this.failureCooldownMs / 1000)}s: ${error?.message ?? 'unknown'}`,
        );
      }
    }
  }

  // ── endpoints ──────────────────────────────────────────────────────────────

  /**
   * Store one memory.
   * @param input - the memory to store.
   * @param options - per-call overrides.
   * @returns the created memory record.
   */
  remember(
    { content, memoryType = 'Conversation', tags, sessionId }: RememberInput,
    options?: CallOptions,
  ) {
    return this.call(
      '/api/remember',
      {
        user_id: this.uid(options),
        content,
        memory_type: memoryType,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        source_type: 'dsh',
      },
      options,
    );
  }

  /**
   * Semantic search.
   * @param input - search parameters.
   * @param options - per-call overrides.
   * @returns the recall response.
   */
  recall({ query, limit = 5, mode = 'semantic', sessionId }: RecallInput, options?: CallOptions) {
    return this.call(
      '/api/recall',
      {
        user_id: this.uid(options),
        query,
        limit,
        mode,
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      options,
    );
  }

  /**
   * Context-aware retrieval: shodh extracts entities from a blob of context and
   * ranks against them, rather than matching the literal query.
   * @param input - proactive-context parameters.
   * @param options - per-call overrides.
   * @returns the proactive-context response.
   */
  proactiveContext({ context, maxResults = 5 }: ProactiveContextInput, options?: CallOptions) {
    return this.call(
      '/api/proactive_context',
      {
        user_id: this.uid(options),
        context,
        max_results: maxResults,
      },
      options,
    );
  }

  /**
   * Categorized overview: recent decisions, learnings, and context.
   * @param maxItems - per-category cap.
   * @param options - per-call overrides.
   * @returns the summary response.
   */
  contextSummary(maxItems = 5, options?: CallOptions) {
    return this.call(
      '/api/context_summary',
      {
        user_id: this.uid(options),
        include_decisions: true,
        include_learnings: true,
        include_context: true,
        max_items: maxItems,
      },
      options,
    );
  }

  /**
   * Delete one memory by id.
   * @param id - the memory id.
   * @param options - per-call overrides.
   * @returns the delete response.
   */
  forget(id: string, options?: CallOptions) {
    return this.call(
      `/api/memory/${encodeURIComponent(id)}?user_id=${encodeURIComponent(this.uid(options))}`,
      undefined,
      {
        method: 'DELETE',
        ...options,
      },
    );
  }

  /**
   * Liveness probe.
   * @param options - per-call overrides.
   * @returns the health payload.
   */
  health(options?: CallOptions) {
    return this.call('/health', undefined, { method: 'GET', ...options });
  }

  /**
   * Per-user storage statistics.
   * @param options - per-call overrides.
   * @returns the stats payload.
   */
  stats(options?: CallOptions) {
    return this.call(`/api/users/${encodeURIComponent(this.uid(options))}/stats`, undefined, {
      method: 'GET',
      ...options,
    });
  }
}

/**
 * Truncate a string for log/error display.
 * @param text - the input.
 * @param max - maximum length.
 * @returns the text, ellipsized when over `max`.
 */
function truncate(text: string, max: number): string {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
