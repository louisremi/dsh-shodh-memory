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
  source: { kind: string; form: string };
}) => unknown;

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
  promptSection: boolean;
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
}
