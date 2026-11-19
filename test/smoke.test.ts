/**
 * End-to-end smoke test.
 *
 * Boots a real cordis context with stub services, applies the actual plugin
 * module against a fake shodh HTTP server, and drives the same events the
 * harness would. Asserts on what the server actually received rather than on
 * internal state — the contract is the wire.
 *
 * Run: `pnpm test`
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Plugin, Service } from '@deepseek-ai/cordis';
import { ShodhClient } from '../src/client.js';
import type {
  AgentTerminalRequestLike,
  CommandDefinition,
  JsonRecord,
  PromptSection,
  ToolDefinition,
} from '../src/types.js';

// ── fake shodh server ────────────────────────────────────────────────────────

interface ReceivedBody extends JsonRecord {
  content?: string;
  memory_type?: string;
  query?: string;
  user_id?: string;
}

interface ReceivedRequest {
  method?: string;
  url?: string;
  key?: string;
  body: ReceivedBody | null;
}

const received: ReceivedRequest[] = [];
let failNext = 0;

const MEMORIES = [
  {
    id: 'm1',
    content: 'The profile uses pnpm with a hoisted node linker.',
    memory_type: 'Decision',
    relevance_score: 0.91,
  },
  {
    id: 'm2',
    content: 'Sandbox denies writes outside the session workspace.',
    memory_type: 'Error',
    relevance_score: 0.74,
  },
  {
    id: 'm3',
    content: 'Auto-recall block is capped at 1200 chars.',
    memory_type: 'Learning',
    relevance_score: 0.55,
  },
  {
    id: 'm4',
    content: 'Weakly related noise that should be filtered out.',
    memory_type: 'Observation',
    relevance_score: 0.05,
  },
];

// The stored inventory for the cleanup pass. `m1`/`m2` are the near-duplicate
// pair the canned LLM proposes to merge; `m1` reports itself truncated so the
// GET-one fetch path runs against a real route.
const CLEANUP_STORE = [
  {
    id: 'c1',
    content: 'The deploy target is the staging host.'.repeat(30),
    content_truncated: true,
    content_length: 990,
    memory_type: 'Decision',
    importance: 0.9,
    tags: ['deploy'],
  },
  {
    id: 'c2',
    content: 'Deploy goes to the staging host, per the release PR.',
    content_truncated: false,
    content_length: 53,
    memory_type: 'Decision',
    importance: 0.8,
    tags: ['deploy'],
  },
  {
    id: 'c3',
    content: 'Superseded: the old deploy target was the dev box.',
    content_truncated: false,
    content_length: 50,
    memory_type: 'Context',
    importance: 0.3,
    tags: [],
  },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      key: req.headers['x-api-key'] as string | undefined,
      body: body ? (JSON.parse(body) as ReceivedBody) : null,
    });

    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated outage' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url?.startsWith('/api/users/')) {
      return res.end(JSON.stringify({ total_memories: 42, tier_ltm: 30 }));
    }
    if (req.url === '/api/remember')
      return res.end(JSON.stringify({ id: `new-${received.length}`, ok: true }));
    if (req.url === '/api/proactive_context') {
      return res.end(JSON.stringify({ memories: MEMORIES, latency_ms: 12.5 }));
    }
    if (req.url === '/api/recall')
      return res.end(JSON.stringify({ memories: MEMORIES.slice(0, 2) }));
    if (req.url === '/api/context_summary') {
      return res.end(
        JSON.stringify({
          decisions: [MEMORIES[0]],
          learnings: [MEMORIES[2]],
          context: [],
        }),
      );
    }
    // Cleanup inventory. One page under the cap, so a single call covers it.
    if (req.url === '/api/memories' && req.method === 'POST') {
      return res.end(
        JSON.stringify({
          memories: CLEANUP_STORE.map((m) =>
            m.content_truncated ? { ...m, content: m.content.slice(0, 500) } : m,
          ),
          total: CLEANUP_STORE.length,
        }),
      );
    }
    if (/^\/api\/memory\/[\w-]+(\?.*)?$/.test(req.url ?? '')) {
      if (req.method === 'GET') {
        const id = (req.url as string).slice('/api/memory/'.length).split('?')[0];
        const found = CLEANUP_STORE.find((m) => m.id === id);
        if (!found) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'not found' }));
        }
        return res.end(JSON.stringify({ ...found, content: found.content, children_ids: [] }));
      }
      if (req.method === 'PUT') return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'DELETE') return res.end(JSON.stringify({ deleted: true }));
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ── stub services ────────────────────────────────────────────────────────────

const registeredTools: ToolDefinition[] = [];
const registeredCommands: CommandDefinition[] = [];
const registeredSections: PromptSection[] = [];

class ToolsStub extends Service {
  register!: (def: ToolDefinition) => () => void;
  constructor(ctx: Context) {
    super(ctx, 'tools');
    this.register = (def) => {
      registeredTools.push(def);
      return () => {
        const i = registeredTools.indexOf(def);
        if (i >= 0) registeredTools.splice(i, 1);
      };
    };
  }
}

class CommandsStub extends Service {
  register!: (def: CommandDefinition) => () => void;
  constructor(ctx: Context) {
    super(ctx, 'commands');
    this.register = (def) => {
      registeredCommands.push(def);
      return () => {};
    };
  }
}

class SystemPromptStub extends Service {
  section!: (s: PromptSection) => () => void;
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt');
    this.section = (s) => {
      registeredSections.push(s);
      return () => {};
    };
  }
}

class SessionsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions');
  }
}

class AgentsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents');
  }
}

// The canned analysis output: one JSONL merge (into the truncated c1) and one
// JSONL delete, exactly in the shape the cleanup contract asks for.
const CANNED_LLM_LINES = [
  '{"op":"merge","ids":["c1","c2"],"into":"c1","text":"Deploys target the staging host, per the release PR.","reason":"two memories state the same deploy target"}',
  'garbage that must be skipped',
  '{"op":"delete","ids":["c3"],"reason":"superseded by the staging deploy decision"}',
];
let llmMode: 'answer' | 'empty' | 'error' = 'answer';
const llmCalls: unknown[] = [];
const llmRequests: unknown[] = [];

/** Minimal LlmRuntime: one provider, frozen prepared config, canned chunk stream. */
class LlmStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm');
    Object.assign(this, {
      listProviders: () => [{ id: 'stub', name: 'Stub' }],
      listModels: async () => [{ id: 'cheap-model', name: 'Cheap' }],
      prepareCall: async (config: Record<string, unknown>) => {
        llmCalls.push(config);
        const preparedConfig = Object.freeze({ ...config });
        return {
          config: preparedConfig,
          async *stream(options: unknown) {
            llmRequests.push(options);
            if (llmMode === 'error') {
              yield {
                type: 'finish',
                reason: { kind: 'error', failure: { message: 'provider exploded' } },
              };
              return;
            }
            const lines = llmMode === 'empty' ? [] : CANNED_LLM_LINES;
            for (const text of lines) yield { type: 'text-delta', index: 0, text: `${text}\n` };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    });
  }
}

// ── boot the plugin ──────────────────────────────────────────────────────────

// `/shodh tui` keeps its state under the DSH home. Point that at a scratch
// directory so this suite never creates anything in the real `~/.dsh`.
const scratchHome = await mkdtemp(join(tmpdir(), 'shodh-smoke-home-'));
process.env.DSH_HOME = scratchHome;

const logs: Array<[string, string]> = [];
const ctx = new Context();
// The plugin only ever needs the four printf-style methods; the fake replaces
// the real logger service without dragging in its full typed surface.
(ctx as unknown as { logger: unknown }).logger = {
  info: (m: unknown, ...a: unknown[]) => logs.push(['info', fmt(m, a)]),
  warn: (m: unknown, ...a: unknown[]) => logs.push(['warn', fmt(m, a)]),
  debug: (m: unknown, ...a: unknown[]) => logs.push(['debug', fmt(m, a)]),
  error: (m: unknown, ...a: unknown[]) => logs.push(['error', fmt(m, a)]),
};

new ToolsStub(ctx);
new CommandsStub(ctx);
new SystemPromptStub(ctx);
new SessionsStub(ctx);
new AgentsStub(ctx);
new LlmStub(ctx);

const mod = await import('../src/index.js');
const entry = mod.default as unknown as Plugin.Object<Record<string, unknown>>;
await ctx.plugin(entry, {
  baseUrl,
  apiKey: 'test-key-123',
  requestTimeoutMs: 2000,
  recallTimeoutMs: 1500,
  captureTimeoutMs: 2000,
  failureThreshold: 3,
  failureCooldownMs: 5000,
  // Any absolute executable will do: the terminal below is a stub and never
  // runs it. This only has to get past binary resolution.
  tui: { path: process.execPath },
});

function fmt(template: unknown, args: unknown[]): string {
  if (typeof template !== 'string') return String(template);
  let i = 0;
  return template.replace(/%[sdjo]/g, () => String(args[i++]));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll a condition every 10ms; resolves true once satisfied, false after timeout.
 * Capture writes reach the fake server asynchronously; fixed sleeps raced on
 * loaded CI runners, so positive assertions wait on the actual effect. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(10);
  }
}

// The harness-level events this test drives live in dsh's own service types,
// not in bare cordis. The plugin registers its listeners through its own
// structural ShodhContext interface, so the test only needs a matching
// structural view of the dispatcher — same object at runtime, typed just far
// enough to drive it.
interface SmokeMessage {
  role?: string;
  content: { type?: string; text: string }[];
  source?: { kind?: string; plugin?: string; form?: string };
}
interface SmokeDecision {
  kind: string;
  messages: SmokeMessage[];
}
interface SmokePreStep {
  agent: { session: { id: string } };
  messages: SmokeMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}
const bus = ctx as unknown as {
  emit(name: 'session/event', session: { id?: string }, event: Record<string, unknown>): void;
  emit(name: 'tools/result', exec: Record<string, unknown>, result: Record<string, unknown>): void;
  events: {
    waterfall(
      name: 'agent/pre-step',
      payload: SmokePreStep,
      next: () => Promise<SmokeDecision>,
    ): Promise<SmokeDecision>;
  };
};

// ── assertions ───────────────────────────────────────────────────────────────

let passed = 0;
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('\n[1] registration');
check('three tools registered', registeredTools.length === 3);
check(
  'tool names',
  ['memory_save', 'memory_search', 'memory_forget'].every((n) =>
    registeredTools.some((t) => t.name === n),
  ),
);
check('one prompt section registered', registeredSections.length === 1);
check('prompt section named shodh-memory', registeredSections[0]?.name === 'shodh-memory');
check(
  '/shodh command registered',
  registeredCommands.some((c) => c.name === 'shodh'),
);

console.log('\n[2] auto-capture: human prompt');
bus.emit(
  'session/event',
  { id: 'sess-1' },
  {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'How do we configure the node linker for the dsh profile?' }],
      source: { kind: 'user' },
    },
  },
);
await waitFor(() => received.some((r) => r.url === '/api/remember'));
const captured = received.filter((r) => r.url === '/api/remember');
check('prompt was stored', captured.length === 1);
check('stored as Conversation', captured[0]?.body?.memory_type === 'Conversation');
check('content matches', Boolean(captured[0]?.body?.content?.includes('node linker')));
check('API key sent', captured[0]?.key === 'test-key-123');

console.log('\n[3] auto-capture: plugin-injected text is NOT re-remembered');
bus.emit(
  'session/event',
  { id: 'sess-1' },
  {
    type: 'user/message',
    seq: 2,
    time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Relevant memories (shodh):\n- [Decision] injected block' }],
      source: { kind: 'plugin', plugin: 'shodh-memory', form: 'recall' },
    },
  },
);
// Rejection is synchronous in the listener (source.kind !== 'user' returns
// before any queueing), so a short settle is enough to prove nothing arrived.
await sleep(50);
check(
  'no feedback loop into the store',
  received.filter((r) => r.url === '/api/remember').length === 1,
);

console.log('\n[4] auto-capture: failed tool call becomes an Error memory');
bus.emit(
  'tools/result',
  {
    name: 'bash',
    callId: 'c1',
    arguments: { command: 'make deploy' },
    agent: { session: { id: 'sess-1' } },
    parent: undefined,
  },
  {
    isError: true,
    content: [{ type: 'text', text: 'exit code 2: missing env var' }],
    error: { message: 'exit code 2' },
  },
);
await waitFor(() =>
  received.some((r) => r.url === '/api/remember' && r.body?.memory_type === 'Error'),
);
const errorMemories = received.filter(
  (r) => r.url === '/api/remember' && r.body?.memory_type === 'Error',
);
check('tool failure captured as Error', errorMemories.length === 1);
check('failure names the tool', Boolean(errorMemories[0]?.body?.content?.includes('bash')));

console.log('\n[5] auto-recall injects a bounded block on step 1');
const userMsg: SmokeMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'Why did our deployment fail last time with the missing env var?' },
  ],
  source: { kind: 'user' },
};
const decision = await bus.events.waterfall(
  'agent/pre-step',
  {
    agent: { session: { id: 'sess-1' } },
    messages: [userMsg],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
const recallCalls = received.filter((r) => r.url === '/api/recall');
check('recall endpoint was called', recallCalls.length >= 1);
check(
  'query derived from the prompt',
  Boolean(recallCalls[0]?.body?.query?.includes('deployment fail')),
);
check('decision still enters', decision.kind === 'enter');
check('one message appended (the recall block)', decision.messages.length === 2);
const injected = decision.messages[1];
check('injected as user role', injected?.role === 'user');
check('attributed to the plugin', injected?.source?.kind === 'plugin:shodh-memory');
check('tagged as recall form', injected?.source?.form === 'recall');
const injectedText = injected?.content[0]?.text ?? '';
check('block has a header', injectedText.startsWith('Relevant memories (shodh):'));
check('low-relevance memory filtered out', !injectedText.includes('noise'));
check(
  'high-relevance memories present',
  injectedText.includes('pnpm') && injectedText.includes('Sandbox'),
);
check('block within budget', injectedText.length <= 1200);
console.log(
  `\n    injected block (${injectedText.length} chars):\n${injectedText
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n')}`,
);

console.log('\n[6] reuse gap suppresses re-injection on the next turn');
const decision2 = await bus.events.waterfall(
  'agent/pre-step',
  {
    agent: { session: { id: 'sess-1' } },
    messages: [userMsg],
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
  },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
check('same memories not re-injected at turn 2', decision2.messages.length === 1);

console.log('\n[7] step > 1 does not re-inject');
const decision3 = await bus.events.waterfall(
  'agent/pre-step',
  {
    agent: { session: { id: 'sess-2' } },
    messages: [userMsg],
    turn: 1,
    step: 2,
    signal: new AbortController().signal,
  },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
check('no injection at step 2', decision3.messages.length === 1);

console.log('\n[8] tools execute against the wire');
const saveTool = registeredTools.find((t) => t.name === 'memory_save');
assert.ok(saveTool, 'memory_save registered');
const saveResult = await saveTool.execute(
  { content: 'We pin Node 22 for the harness.', type: 'Decision' },
  { agent: { session: { id: 's' } } },
);
check('memory_save returns saved', saveResult.saved === true);
check(
  'memory_save hit /api/remember',
  received.some(
    (r) => r.url === '/api/remember' && r.body?.content === 'We pin Node 22 for the harness.',
  ),
);

const searchTool = registeredTools.find((t) => t.name === 'memory_search');
assert.ok(searchTool, 'memory_search registered');
const searchResult = await searchTool.execute({ query: 'node linker', limit: 3 }, {});
check('memory_search returns results', searchResult.count === 2);
check(
  'rendered results are text',
  String(searchTool.output.render({}, searchResult)[0]?.text).includes('pnpm'),
);

// The clip bug. Search results used to inherit the injected block's 220-char cap,
// so a long memory came back as an abbreviated index line. `render` is the only
// thing the model sees, so this is the assertion that actually matters — and it
// runs through the registered tool, which is what proves the config reaches it.
const LONG_MEMORY = {
  id: 'long-1',
  content: 'Config v3 rollout notes. '.repeat(20),
  type: 'Learning',
  score: 0.8,
};
const longRender = String(
  searchTool.output.render({}, { count: 1, results: [LONG_MEMORY] })[0]?.text,
);
check('a long search result survives render intact', longRender.includes(LONG_MEMORY.content));
check('a long search result carries no truncation marker', !longRender.includes('…'));
check('a long search result is longer than the recall-block cap', longRender.length > 220);

const forgetTool = registeredTools.find((t) => t.name === 'memory_forget');
assert.ok(forgetTool, 'memory_forget registered');
const forgetResult = await forgetTool.execute({ id: 'm1' }, {});
check(
  'memory_forget issues DELETE',
  received.some((r) => r.method === 'DELETE' && String(r.url).includes('/api/memory/m1')),
);
check('memory_forget reports success', forgetResult.forgotten === true);

console.log('\n[9] slash command');
const mainCommand = registeredCommands.find((c) => c.name === 'shodh');
assert.ok(mainCommand, '/shodh command registered');
const statusOut = await mainCommand.handler({
  rawInput: 'status',
  agent: { session: { id: 's' } },
});
check('/shodh status succeeds', statusOut.kind === 'success');
check('status reports tenant', statusOut.text.includes('tenant    dsh'));
check('status reports circuit', statusOut.text.includes('circuit   closed'));
check('status reports version header', statusOut.text.startsWith('shodh-memory  v'));
check('status reports effective recall config', statusOut.text.includes('recall    on'));
check('status reports activity section', statusOut.text.includes('activity  '));
const summaryOut = await mainCommand.handler({ rawInput: 'summary', agent: {} });
check('/shodh summary lists decisions', summaryOut.text.includes('Decisions:'));
const badOut = await mainCommand.handler({ rawInput: 'bogus', agent: {} });
check('unknown subcommand errors', badOut.kind === 'error');
const helpOut = await mainCommand.handler({ rawInput: 'help', agent: {} });
check('help lists the tui verb', helpOut.text.includes('/shodh tui '));
check(
  'help lists tui install',
  helpOut.text.includes(
    '/shodh tui install       Download the shodh-tui binary (or a [version] of it)',
  ),
);
check(
  'help lists tui clean',
  helpOut.text.includes('/shodh tui clean [all]   Remove downloaded binaries it no longer runs'),
);
check('the input hint offers tui', Boolean(mainCommand.input?.hint?.includes('| tui]')));

console.log('\n[9b] /shodh tui');
// The plugin booted above with no terminal services, as a headless profile
// does — and everything before this line worked. Only this verb says no.
const tuiHeadless = await mainCommand.handler({ rawInput: 'tui', agent: { id: 'sess-tui' } });
check('without terminal services /shodh tui errors', tuiHeadless.kind === 'error');
check('…and says where it works', tuiHeadless.text.includes('Web and Desktop'));

// The Web and Desktop apps provide the two services. They are looked up when
// the command runs, so registering them now — after the plugin started, and
// without either being in its `inject` — is exactly the production order.
const terminalRequests: AgentTerminalRequestLike[] = [];
const terminalWrites: string[] = [];
let terminalClosed = false;
class TerminalControllerStub extends Service {
  openForAgent!: (agent: unknown, request: AgentTerminalRequestLike) => Promise<unknown>;
  constructor(ctx: Context) {
    super(ctx, 'terminalController');
    this.openForAgent = async (_agent, request) => {
      terminalRequests.push(request);
      return {
        info: { state: 'running', control: 'agent', exitCode: null },
        revision: 1,
        // Nothing more is ever printed, so a wait only ends by being aborted —
        // and then rejects, as the real terminal's does.
        changed: (_after: number, signal: AbortSignal) =>
          new Promise<number>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        write: async (data: string) => {
          terminalWrites.push(data);
        },
        drain: async () => {},
        read: () => ({ text: 'user@host:~$ ' }),
        close: async () => {
          terminalClosed = true;
        },
      };
    };
  }
}
class SandboxPolicyStub extends Service {
  resolve!: (request: { session?: unknown }) => unknown;
  constructor(ctx: Context) {
    super(ctx, 'sandboxPolicy');
    this.resolve = () => ({ mode: 'workspace-write' });
  }
}
new TerminalControllerStub(ctx);
new SandboxPolicyStub(ctx);

const tuiOut = await mainCommand.handler({ rawInput: 'tui', agent: { id: 'sess-tui' } });
check('with terminal services /shodh tui succeeds', tuiOut.kind === 'success');
check('one sidebar terminal requested', terminalRequests.length === 1);
check('titled "Shodh memory"', terminalRequests[0]?.title === 'Shodh memory');
check(
  'it starts in the plugin state directory',
  terminalRequests[0]?.cwd === join(scratchHome, 'plugins', 'shodh-memory', 'tui'),
);
check(
  'the TUI is pointed at the configured server',
  terminalRequests[0]?.env?.SHODH_SERVER_URL === baseUrl,
);
check(
  "the plugin's API key reaches it",
  terminalRequests[0]?.env?.SHODH_API_KEY === 'test-key-123',
);
check(
  'one line is typed: exec the binary',
  terminalWrites.length === 1 && terminalWrites[0] === ` exec '${process.execPath}' || exit 127\r`,
);
check('the result names the tenant to pick', tuiOut.text.includes('"dsh"'));
const tuiAgain = await mainCommand.handler({ rawInput: 'tui', agent: { id: 'sess-tui' } });
check('a second /shodh tui opens nothing new', terminalRequests.length === 1);
check('…and says it is already open', tuiAgain.text.includes('already open'));

console.log('\n[10] resilience: circuit breaker');
failNext = 20;
const beforeFailures = received.length;
for (let i = 0; i < 4; i += 1) {
  bus.emit(
    'session/event',
    { id: 'sess-9' },
    {
      type: 'user/message',
      seq: 10 + i,
      time: Date.now(),
      data: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Outage probe ${i}: this write must fail without throwing into the harness.`,
          },
        ],
        source: { kind: 'user' },
      },
    },
  );
}
const breakerOpened = await waitFor(() => logs.some(([, m]) => m.includes('circuit open')), 5000);
await sleep(50); // remaining queued writes short-circuit once the breaker is open
check('failures did not crash the process', true);
check('breaker opened after threshold', breakerOpened);
const warnLogs = logs.filter(([, m]) => m.includes('circuit open'));
check('breaker logged a warning', warnLogs.length >= 1);

const afterOutage = received.length;
bus.emit(
  'session/event',
  { id: 'sess-9' },
  {
    type: 'user/message',
    seq: 99,
    time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Post-breaker probe: should not touch the socket at all.' }],
      source: { kind: 'user' },
    },
  },
);
await sleep(200);
check('open breaker makes no further network calls', received.length === afterOutage);
console.log(
  `    requests before outage: ${beforeFailures}, during: ${afterOutage}, after breaker: ${received.length}`,
);

console.log('\n[11] output schemas are plain JSON Schema (not schemastery)');
for (const tool of registeredTools) {
  assert.equal(typeof tool.output.schema, 'object');
  assert.equal(tool.output.schema.type, 'object');
  assert.ok(
    !('validate' in tool.output.schema),
    `${tool.name}: schema must be a plain value schema object`,
  );
}
check('all tool output schemas are plain JSON Schema', true);

console.log('\n[12] tenant override reaches the wire');
failNext = 0;
const scoped = new ShodhClient({
  baseUrl,
  apiKey: 'scoped-key',
  userId: 'dsh:default-project',
  requestTimeoutMs: 2000,
  failureThreshold: 3,
  failureCooldownMs: 1000,
});
await scoped.remember({ content: 'Tenant check A.' }, {});
await scoped.remember({ content: 'Tenant check B.' }, { userId: 'dsh:other-project' });
const tenantA = received.find(
  (r) => r.url === '/api/remember' && r.body?.content === 'Tenant check A.',
);
const tenantB = received.find(
  (r) => r.url === '/api/remember' && r.body?.content === 'Tenant check B.',
);
check('default tenant used when no override', tenantA?.body?.user_id === 'dsh:default-project');
check('per-call override wins', tenantB?.body?.user_id === 'dsh:other-project');
check('uid() falls back to the process default', scoped.uid(undefined) === 'dsh:default-project');

console.log('\n[13] cleanup: propose, confirm, apply');
// `cleanup` is a new command verb with a new report format; every string the
// pass prints is a deliberate pin. Section [10] opened this fiber's breaker
// with a five-second cooldown, and cleanup — correctly — honors it. Run the
// whole phase against a fresh context: isolation, and no cooldown to race.
const freshCtx = new Context();
(freshCtx as unknown as { logger: unknown }).logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
};
new ToolsStub(freshCtx);
const freshCommands: CommandDefinition[] = [];
class CommandsCaptureStub extends Service {
  register!: (def: CommandDefinition) => () => void;
  constructor(ctx: Context) {
    super(ctx, 'commands');
    this.register = (def) => {
      freshCommands.push(def);
      return () => {};
    };
  }
}
new CommandsCaptureStub(freshCtx);
new SystemPromptStub(freshCtx);
new SessionsStub(freshCtx);
new AgentsStub(freshCtx);
new LlmStub(freshCtx);
llmCalls.length = 0;
llmRequests.length = 0;
await freshCtx.plugin(entry, {
  baseUrl,
  apiKey: 'test-key-123',
  requestTimeoutMs: 2000,
  cleanup: { timeoutMs: 20000 },
});
const cleanupCommand = freshCommands.find((c) => c.name === 'shodh');
assert.ok(cleanupCommand, '/shodh registered in the cleanup context');

const cleanupOut = await cleanupCommand.handler({ rawInput: 'cleanup', agent: {} });
check('/shodh cleanup succeeds', cleanupOut.kind === 'success');
const listCall = received.find(
  (r) => r.url === '/api/memories' && r.method === 'POST' && r.body?.user_id === 'dsh',
);
check('cleanup lists memories over the wire', Boolean(listCall));
check(
  'list call carries the page window',
  listCall?.body?.limit === 100 && listCall?.body?.offset === 0,
);
check(
  'report header names the tenant',
  cleanupOut.text.startsWith('shodh cleanup  dsh  3 memories scanned'),
);
check('report numbers the merge proposal', cleanupOut.text.includes('1. merge 2 memories → c1'));
check('report numbers the delete proposal', cleanupOut.text.includes('2. delete c3'));
check(
  'report carries the merged text',
  cleanupOut.text.includes('Deploys target the staging host'),
);
check('report ends with the apply instruction', cleanupOut.text.includes('/shodh cleanup apply'));
check('cleanup called the prepared llm route once', llmMode === 'answer' && llmCalls.length === 1);
check(
  'cleanup prepared the discovered route with its output cap',
  (llmCalls[0] as Record<string, unknown>).provider === 'stub' &&
    (llmCalls[0] as Record<string, unknown>).model === 'cheap-model' &&
    (llmCalls[0] as Record<string, unknown>).maxTokens === 4000,
);
check(
  'truncated list items were fetched in full',
  received.some((r) => r.method === 'GET' && String(r.url).startsWith('/api/memory/c1?')),
);
// The full-text path is observable in the request the stub saw: c1's preview
// marker is gone and its uncapped full text is in the corpus.
const firstRequest = llmRequests[0] as {
  messages: SmokeMessage[];
  purpose?: string;
  provider?: string;
};
const corpusText = firstRequest.messages[0]?.content[0]?.text ?? '';
check(
  'the analysis request carries the shodh-cleanup purpose',
  firstRequest.purpose === 'shodh-cleanup',
);
check('the request used the prepared route', firstRequest.provider === 'stub');
check(
  'the corpus holds every scanned id',
  ['c1', 'c2', 'c3'].every((id) => corpusText.includes(id)),
);
check('the truncated item lost its preview marker', !corpusText.includes('(truncated)'));
check(
  'the truncated item went in at full length',
  corpusText.includes('The deploy target is the staging host.The deploy target'),
);
check(
  'nothing was mutated by the proposal pass',
  !received.some(
    (r) => r.method === 'PUT' || (r.method === 'DELETE' && String(r.url).includes('c3')),
  ),
);

const applyOut = await cleanupCommand.handler({ rawInput: 'cleanup apply 1', agent: {} });
check('apply succeeds', applyOut.kind === 'success');
check('apply reports the merge', applyOut.text.includes('#1 merged 2 → c1'));
check('apply reports the forgotten copy', applyOut.text.includes('forgot c2'));
check('apply did not run proposal 2', !applyOut.text.includes('#2'));
check(
  'only the selected proposal hit the wire',
  !received.some((r) => r.method === 'DELETE' && String(r.url).includes('c3')),
);
const putCall = received.find((r) => r.method === 'PUT' && String(r.url) === '/api/memory/c1');
check('merge rewrote the kept memory in place', Boolean(putCall));
check(
  'PUT body carries tenant and consolidated text',
  putCall?.body?.user_id === 'dsh' &&
    putCall?.body?.content === 'Deploys target the staging host, per the release PR.',
);
check(
  'the merged-away copy was deleted',
  received.some((r) => r.method === 'DELETE' && String(r.url).includes('/api/memory/c2')),
);

llmMode = 'empty';
const emptyOut = await cleanupCommand.handler({ rawInput: 'cleanup', agent: {} });
check('empty analysis still reports success', emptyOut.kind === 'success');
check(
  'empty analysis says nothing was proposed',
  emptyOut.text.includes('No consolidation proposed'),
);

llmMode = 'error';
const errorOut = await cleanupCommand.handler({ rawInput: 'cleanup', agent: {} });
check('a failed model call errors cleanly', errorOut.kind === 'error');
check(
  'the error names the cause and the no-change promise',
  errorOut.text.includes('provider exploded') && errorOut.text.includes('nothing was changed.'),
);
llmMode = 'answer';

const usageOut = await cleanupCommand.handler({ rawInput: 'cleanup sideways', agent: {} });
check(
  'bad cleanup argument shows usage',
  usageOut.kind === 'error' && usageOut.text.includes('Usage: /shodh cleanup'),
);
const applyWithoutReport = await cleanupCommand.handler({
  rawInput: 'cleanup apply 404',
  agent: {},
});
check('apply with no matching number errors', applyWithoutReport.kind === 'error');
const cleanupHelpOut = await cleanupCommand.handler({ rawInput: 'help', agent: {} });
check('help lists cleanup', cleanupHelpOut.text.includes('/shodh cleanup'));
const statusCleanup = await cleanupCommand.handler({ rawInput: 'status', agent: {} });
check(
  'status reports the cleanup line',
  statusCleanup.text.includes('cleanup   auto · ≤200 memories'),
);

await freshCtx.fiber.dispose();

await ctx.fiber.dispose();
console.log('\n[14] teardown');
check('disposing the plugin closes the TUI terminal it still controls', terminalClosed);
console.log(`\n${passed} checks passed.\n`);
server.close();
await rm(scratchHome, { recursive: true, force: true });
process.exit(0);
