/**
 * Structural types shared across the plugin.
 *
 * The plugin runs inside DSH (cordis), but cordis and the optional DSH peer
 * packages are runtime dependencies the plugin must not statically import: the
 * plugin is loaded by name from a patch overlay, and its peers may be absent.
 * So everything the plugin *receives* from the host is described here with
 * minimal structural interfaces — only the members this plugin actually uses.
 *
 * @module types
 */

/** Any JSON-compatible value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/** A JSON object; index signature allows optional-looking reads. */
export interface JsonRecord {
  [key: string]: JsonValue | undefined;
}

/** The subset of the cordis logger this plugin calls. */
export interface ShodhLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** A reference to the agent that triggered a call, as far as we inspect it. */
export interface AgentRef {
  id?: string;
  session?: { id?: string };
  workspaceCwd?: string;
  workspace?: { cwd?: string };
  /** The agent's own context; selects the session's execution providers. */
  ctx?: { get?(name: string): unknown };
}

/** The session reference carried by session events. */
export interface SessionRef {
  id?: string;
}

/** The message shape this plugin reads out of session events. */
export interface MessageLike {
  role?: string;
  content?: unknown;
  source?: { kind?: string; [key: string]: unknown };
}

/** A session event as dispatched on `session/event`. */
export interface SessionEvent {
  type?: string;
  data?: MessageLike;
}

/** The execution context of a finished tool call (`tools/result`). */
export interface ToolResultExec {
  name: string;
  /** Present when the call was a nested (e.g. PTC) sub-dispatch. */
  parent?: unknown;
  agent?: AgentRef;
}

/** The result payload of a finished tool call (`tools/result`). */
export interface ToolResultPayload {
  isError?: boolean;
  content?: unknown;
  error?: { message?: string; info?: { reason?: string } };
}

/** The payload of the `agent/pre-step` waterfall. */
export interface PreStepPayload {
  agent?: AgentRef;
  turn: number;
  step?: number;
  signal?: AbortSignal;
}

/** The decision returned by the `agent/pre-step` waterfall. */
export interface PreStepDecision {
  kind: string;
  messages: unknown[];
  [key: string]: unknown;
}

/** What the tool executor hands to `execute`. */
export interface ToolExec {
  agent?: AgentRef;
  [key: string]: unknown;
}

/** A render block produced by a tool's `output.render`. */
export interface ToolRenderBlock {
  type: string;
  text: string;
  [key: string]: unknown;
}

/** The tool definition shape `defineTool` accepts and returns. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonRecord;
  output: {
    schema: JsonRecord;
    render: (args: JsonRecord, value: JsonRecord) => ToolRenderBlock[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: JsonRecord) => boolean;
  execute: (args: JsonRecord, exec: ToolExec) => Promise<JsonRecord>;
  presentCall?: (args: JsonRecord) => ToolPresentCall;
}

/** The `defineTool` export of `@deepseek-ai/dsh-tools`, as used here. */
export type DefineTool = (options: ToolDefinition) => ToolDefinition;

/** The presentCall descriptor a tool returns for the UI. */
export interface ToolPresentCall {
  card: string;
  title: string;
  kind: string;
  rawInput?: unknown;
  [key: string]: unknown;
}

/** The `createUserMessage` export of `@deepseek-ai/dsh-llm`, as used here. */
export type CreateUserMessage = (input: {
  content: { type: string; text: string }[];
  source: { kind: string; form: string; summary?: string };
}) => unknown;

/** A chunk of the raw adapter stream, as far as cleanup assembly reads it. */
export interface StreamChunkLike {
  type: string;
  text?: string;
  reason?: { kind?: string; failure?: { message?: string } };
  [key: string]: unknown;
}

/** The subset of `LlmRuntime` the cleanup pass uses. */
export interface LlmRuntimeLike {
  listProviders(): { id: string; name?: string }[];
  listModels(provider: string): Promise<{ id: string }[]>;
  prepareCall(config: JsonRecord, signal?: AbortSignal): Promise<PreparedLlmCallLike>;
}

/** One prepared call: dispatch once, with the request's config fields matching `config`. */
export interface PreparedLlmCallLike {
  readonly config: JsonRecord;
  /** The assembled request carries live objects (messages, signal), hence `unknown` values. */
  stream(options: { [key: string]: unknown }): AsyncIterable<StreamChunkLike>;
}

/** The `BlockAssembler` constructor of `@deepseek-ai/dsh-llm`, as used here. */
export interface BlockAssemblerCtor {
  new (): {
    push(chunk: StreamChunkLike): void;
    readonly finish: { kind?: string; failure?: { message?: string } };
  };
}

/** One memory as returned by the shodh list endpoints (`POST /api/memories`). */
export interface ListMemoryItem {
  id: string;
  content: string;
  /** True when `content` is a server-side preview cut short of the full text. */
  truncated: boolean;
  type: string;
  importance: number;
  tags: string[];
}

/** The command definition shape accepted by `ctx.commands.register`. */
export interface CommandDefinition {
  name: string;
  description: string;
  input?: { hint?: string };
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

/** The invocation object a command handler receives. */
export interface CommandInvocation {
  rawInput?: string;
  agent?: AgentRef;
  /** Cancellation owned by the dispatching UI request. */
  signal?: AbortSignal;
}

/** The result a command handler returns. */
export interface CommandResult {
  kind: string;
  text: string;
}

/** A system-prompt section descriptor. */
export interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/**
 * The subset of the cordis context this plugin uses, as a structural type so
 * the plugin compiles (and runs) without cordis' own types being load-bearing.
 */
export interface ShodhContext {
  logger?: ShodhLogger;
  tools: {
    register(definition: ToolDefinition): () => void;
  };
  commands: {
    register(definition: CommandDefinition): () => void;
  };
  systemPrompt: {
    section(section: PromptSection): () => void;
  };
  on(
    name: 'session/event',
    listener: (session: SessionRef, event: SessionEvent) => void,
  ): () => void;
  on(
    name: 'tools/result',
    listener: (exec: ToolResultExec, result: ToolResultPayload) => void,
  ): () => void;
  on(
    name: 'agent/pre-step',
    listener: (
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>,
  ): () => void;
  effect(callback: () => () => void, name?: string): void;
  /**
   * Look up a service that may be absent. Used for the services that must not
   * be in `inject`, because the rest of the plugin has to keep working without
   * them: the Web/Desktop-only terminal services, and `llm` (as
   * {@link LlmRuntimeLike}), which only `/shodh cleanup` needs. Never read
   * these as `ctx.<name>`: cordis throws for an un-injected property.
   */
  get?(name: string): unknown;
}

/** Process and input state of a sidebar terminal, as far as we read it. */
export interface TerminalInfoLike {
  state: string;
  control?: string;
  exitCode?: number | null;
  error?: string;
}

/**
 * The agent-side handle of one sidebar terminal — the members this plugin uses
 * of `AgentTerminal` from `@deepseek-ai/dsh-api-terminal-controller`.
 */
export interface AgentTerminalLike {
  readonly info: TerminalInfoLike;
  /** Advances after applied output and published state changes. */
  readonly revision: number;
  changed(after: number, signal: AbortSignal): Promise<number>;
  write(data: string): Promise<void>;
  drain(): Promise<void>;
  read(request: { offset: number; count: number; maxBytes: number }): { text: string };
  close(): Promise<void>;
}

/** What `openForAgent` is asked for. */
export interface AgentTerminalRequestLike {
  title: string;
  cwd?: string;
  cols: number;
  rows: number;
  policy: unknown;
  preferredShells: readonly string[];
  env?: Record<string, string>;
}

/** `ctx.terminalController`, as used here. */
export interface TerminalControllerLike {
  openForAgent(
    agent: unknown,
    request: AgentTerminalRequestLike,
    signal: AbortSignal,
  ): Promise<AgentTerminalLike>;
}

/** `ctx.sandboxPolicy`, as used here. */
export interface SandboxPolicyLike {
  resolve(request: { session?: unknown }): unknown;
}

/** The session's `subprocess` provider, as used here. */
export interface SubprocessLike {
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Normalized plugin configuration (see config.ts for defaults). */
export interface ShodhConfig {
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
  userId: string;
  userIdScope: 'global' | 'workspace';
  requestTimeoutMs: number;
  recallTimeoutMs: number;
  captureTimeoutMs: number;
  failureThreshold: number;
  failureCooldownMs: number;
  tools: {
    save: boolean;
    search: boolean;
    forget: boolean;
    searchResultMaxChars: number;
  };
  autoRecall: {
    enabled: boolean;
    maxChars: number;
    maxResults: number;
    minPromptChars: number;
    reuseGapTurns: number;
    queryChars: number;
  };
  autoCapture: {
    enabled: boolean;
    userPrompts: boolean;
    toolErrors: boolean;
    assistantReplies: boolean;
    maxChars: number;
    minChars: number;
  };
  cleanup: {
    maxMemories: number;
    maxFetches: number;
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    provider?: string;
    model?: string;
  };
  promptSection: boolean;
  tui: {
    enabled: boolean;
    path: string;
    version: string;
    cols: number;
    rows: number;
  };
}

/** Per-turn activity counters surfaced by `/shodh status`. */
export interface ActivityCounters {
  captured: number;
  captureSkipped: number;
  recalled: number;
  recallEmpty: number;
  lastInjectChars: number;
  lastInjectAt: number;
  lastCaptureAt: number;
}

/** State shared by recall, capture, and the command for one plugin fiber. */
export interface PluginState {
  /** sha1(content) of everything stored this process, for dedupe. */
  capturedHashes: Set<string>;
  /** Per-ledger map of memory key → turn last injected into it. */
  injectedTurns: Map<string, Map<string, number>>;
  activity: ActivityCounters;
  /**
   * The last `/shodh cleanup` report per tenant, held for `cleanup apply`.
   * Keyed by tenant so one workspace can never apply another's proposals.
   * Nothing is applied without that second human command.
   */
  cleanupReports: Map<string, CleanupReport>;
}

/** One LLM-proposed memory-store edit. Never executed without `/shodh cleanup apply`. */
export interface CleanupProposal {
  /** `merge` consolidate several memories; `delete` drop a stale one. */
  op: 'merge' | 'delete';
  /** Ids the proposal acts on. */
  ids: string[];
  /** For a merge: keep this id and rewrite it with `text` instead of re-adding. */
  into?: string;
  /** For a merge: the consolidated memory text. */
  text?: string;
  /** One-line justification, shown in the report. */
  reason?: string;
}

/**
 * One `/shodh cleanup` run, held until it is applied, expires, or the next run
 * replaces it. Every field is checked again at apply time.
 */
export interface CleanupReport {
  /** The tenant analyzed. Apply refuses to run under any other tenant. */
  tenant: string;
  proposals: CleanupProposal[];
  /** Ids that made it into the analysis input (possibly cut). A delete needs these. */
  seenIds: Set<string>;
  /**
   * Ids whose whole text was in the analysis input. A merge rewrites or deletes
   * every id it names, so all of them must be here — otherwise text the model
   * never saw would be lost.
   */
  fullIds: Set<string>;
  /** Epoch ms; apply refuses a report past the cleanup report TTL. */
  created: number;
  /** Proposal indexes already executed; re-applying them is a no-op. */
  applied: Set<number>;
}

/** A memory rendered for display, normalized by format.ts. */
export interface RenderableMemory {
  id?: string;
  content: string;
  type: string;
  score: number;
  tier?: string;
  tags?: string[];
}

/** Input to `ShodhClient.remember`. */
export interface RememberInput {
  content: string;
  memoryType?: string;
  tags?: string[];
  sessionId?: string;
}

/** Per-call client overrides. */
export interface CallOptions {
  method?: string;
  timeoutMs?: number;
  /** Tenant override; wins over the client's default user id. */
  userId?: string;
  /**
   * Caller cancellation. Aborting it cancels the request; it is the caller's
   * decision, not a server failure, so it never counts against the breaker.
   */
  signal?: AbortSignal;
}
