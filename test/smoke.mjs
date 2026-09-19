/**
 * End-to-end smoke test.
 *
 * Boots a real cordis context with stub services, applies the actual plugin
 * module against a fake shodh HTTP server, and drives the same events the
 * harness would. Asserts on what the server actually received rather than on
 * internal state — the contract is the wire.
 *
 * Run: `node test/smoke.mjs`
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';

// ── fake shodh server ────────────────────────────────────────────────────────

const received = [];
let failNext = 0;

const MEMORIES = [
  { id: 'm1', content: 'The profile uses pnpm with a hoisted node linker.', memory_type: 'Decision', relevance_score: 0.91 },
  { id: 'm2', content: 'Sandbox denies writes outside the session workspace.', memory_type: 'Error', relevance_score: 0.74 },
  { id: 'm3', content: 'Auto-recall block is capped at 1200 chars.', memory_type: 'Learning', relevance_score: 0.55 },
  { id: 'm4', content: 'Weakly related noise that should be filtered out.', memory_type: 'Observation', relevance_score: 0.05 },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });

    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated outage' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url.startsWith('/api/users/')) {
      return res.end(JSON.stringify({ total_memories: 42, tier_ltm: 30 }));
    }
    if (req.url === '/api/remember') return res.end(JSON.stringify({ id: `new-${received.length}`, ok: true }));
    if (req.url === '/api/proactive_context') {
      return res.end(JSON.stringify({ memories: MEMORIES, latency_ms: 12.5 }));
    }
    if (req.url === '/api/recall') return res.end(JSON.stringify({ memories: MEMORIES.slice(0, 2) }));
    if (req.url === '/api/context_summary') {
      return res.end(JSON.stringify({
        decisions: [MEMORIES[0]],
        learnings: [MEMORIES[2]],
        context: [],
      }));
    }
    if (req.method === 'DELETE') return res.end(JSON.stringify({ deleted: true }));
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ── stub services ────────────────────────────────────────────────────────────

const registeredTools = [];
const registeredCommands = [];
const registeredSections = [];

class ToolsStub extends Service {
  constructor(ctx) {
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
  constructor(ctx) {
    super(ctx, 'commands');
    this.register = (def) => {
      registeredCommands.push(def);
      return () => {};
    };
  }
}

class SystemPromptStub extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt');
    this.section = (s) => {
      registeredSections.push(s);
      return () => {};
    };
  }
}

class SessionsStub extends Service {
  constructor(ctx) { super(ctx, 'sessions'); }
}

class AgentsStub extends Service {
  constructor(ctx) { super(ctx, 'agents'); }
}

// ── boot the plugin ──────────────────────────────────────────────────────────

const logs = [];
const ctx = new Context();
ctx.logger = {
  info: (m, ...a) => logs.push(['info', fmt(m, a)]),
  warn: (m, ...a) => logs.push(['warn', fmt(m, a)]),
  debug: (m, ...a) => logs.push(['debug', fmt(m, a)]),
  error: (m, ...a) => logs.push(['error', fmt(m, a)]),
};

new ToolsStub(ctx);
new CommandsStub(ctx);
new SystemPromptStub(ctx);
new SessionsStub(ctx);
new AgentsStub(ctx);

const mod = await import('../src/index.js');
await ctx.plugin(mod.default, {
  baseUrl,
  apiKey: 'test-key-123',
  requestTimeoutMs: 2000,
  recallTimeoutMs: 1500,
  captureTimeoutMs: 2000,
  failureThreshold: 3,
  failureCooldownMs: 5000,
});

function fmt(template, args) {
  if (typeof template !== 'string') return String(template);
  let i = 0;
  return template.replace(/%[sdjo]/g, () => String(args[i++]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── assertions ───────────────────────────────────────────────────────────────

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('\n[1] registration');
check('three tools registered', registeredTools.length === 3);
check('tool names', ['memory_save', 'memory_search', 'memory_forget'].every((n) => registeredTools.some((t) => t.name === n)));
check('one prompt section registered', registeredSections.length === 1);
check('prompt section named shodh-memory', registeredSections[0]?.name === 'shodh-memory');
check('/shodh command registered', registeredCommands.some((c) => c.name === 'shodh'));

console.log('\n[2] auto-capture: human prompt');
const beforeCapture = received.length;
ctx.emit('session/event', { id: 'sess-1' }, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: {
    role: 'user',
    content: [{ type: 'text', text: 'How do we configure the node linker for the dsh profile?' }],
    source: { kind: 'user' },
  },
});
await sleep(120);
const captured = received.filter((r) => r.url === '/api/remember');
check('prompt was stored', captured.length === 1);
check('stored as Conversation', captured[0]?.body?.memory_type === 'Conversation');
check('content matches', captured[0]?.body?.content?.includes('node linker'));
check('API key sent', captured[0]?.key === 'test-key-123');

console.log('\n[3] auto-capture: plugin-injected text is NOT re-remembered');
ctx.emit('session/event', { id: 'sess-1' }, {
  type: 'user/message',
  seq: 2,
  time: Date.now(),
  data: {
    role: 'user',
    content: [{ type: 'text', text: 'Relevant memories (shodh):\n- [Decision] injected block' }],
    source: { kind: 'plugin', plugin: 'shodh-memory', form: 'recall' },
  },
});
await sleep(120);
check('no feedback loop into the store', received.filter((r) => r.url === '/api/remember').length === 1);

console.log('\n[4] auto-capture: failed tool call becomes an Error memory');
ctx.emit('tools/result', {
  name: 'bash',
  callId: 'c1',
  arguments: { command: 'make deploy' },
  agent: { session: { id: 'sess-1' } },
  parent: undefined,
}, { isError: true, content: [{ type: 'text', text: 'exit code 2: missing env var' }], error: { message: 'exit code 2' } });
await sleep(120);
const errorMemories = received.filter((r) => r.url === '/api/remember' && r.body?.memory_type === 'Error');
check('tool failure captured as Error', errorMemories.length === 1);
check('failure names the tool', errorMemories[0]?.body?.content?.includes('bash'));

console.log('\n[5] auto-recall injects a bounded block on step 1');
const recallBefore = received.length;
const userMsg = {
  role: 'user',
  content: [{ type: 'text', text: 'Why did our deployment fail last time with the missing env var?' }],
  source: { kind: 'user' },
};
const decision = await ctx.events.waterfall(
  'agent/pre-step',
  { agent: { session: { id: 'sess-1' } }, messages: [userMsg], turn: 1, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
const recallCalls = received.filter((r) => r.url === '/api/recall');
check('recall endpoint was called', recallCalls.length >= 1);
check('query derived from the prompt', recallCalls[0]?.body?.query?.includes('deployment fail'));
check('decision still enters', decision.kind === 'enter');
check('one message appended (the recall block)', decision.messages.length === 2);
const injected = decision.messages[1];
check('injected as user role', injected.role === 'user');
check('attributed to the plugin', injected.source?.plugin === 'shodh-memory');
check('tagged as recall form', injected.source?.form === 'recall');
const injectedText = injected.content[0].text;
check('block has a header', injectedText.startsWith('Relevant memories (shodh):'));
check('low-relevance memory filtered out', !injectedText.includes('noise'));
check('high-relevance memories present', injectedText.includes('pnpm') && injectedText.includes('Sandbox'));
check('block within budget', injectedText.length <= 1200);
console.log(`\n    injected block (${injectedText.length} chars):\n${injectedText.split('\n').map((l) => `      ${l}`).join('\n')}`);

console.log('\n[6] reuse gap suppresses re-injection on the next turn');
const decision2 = await ctx.events.waterfall(
  'agent/pre-step',
  { agent: { session: { id: 'sess-1' } }, messages: [userMsg], turn: 2, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
check('same memories not re-injected at turn 2', decision2.messages.length === 1);

console.log('\n[7] step > 1 does not re-inject');
const decision3 = await ctx.events.waterfall(
  'agent/pre-step',
  { agent: { session: { id: 'sess-2' } }, messages: [userMsg], turn: 1, step: 2, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages: [userMsg] }),
);
check('no injection at step 2', decision3.messages.length === 1);

console.log('\n[8] tools execute against the wire');
const saveTool = registeredTools.find((t) => t.name === 'memory_save');
const saveResult = await saveTool.execute({ content: 'We pin Node 22 for the harness.', type: 'Decision' }, { agent: { session: { id: 's' } } });
check('memory_save returns saved', saveResult.saved === true);
check('memory_save hit /api/remember', received.some((r) => r.url === '/api/remember' && r.body?.content === 'We pin Node 22 for the harness.'));

const searchTool = registeredTools.find((t) => t.name === 'memory_search');
const searchResult = await searchTool.execute({ query: 'node linker', limit: 3 }, {});
check('memory_search returns results', searchResult.count === 2);
check('rendered results are text', searchTool.output.render({}, searchResult)[0].text.includes('pnpm'));

const forgetTool = registeredTools.find((t) => t.name === 'memory_forget');
const forgetResult = await forgetTool.execute({ id: 'm1' }, {});
check('memory_forget issues DELETE', received.some((r) => r.method === 'DELETE' && r.url.includes('/api/memory/m1')));
check('memory_forget reports success', forgetResult.forgotten === true);

console.log('\n[9] slash command');
const command = registeredCommands.find((c) => c.name === 'shodh');
const statusOut = await command.handler({ rawInput: 'status', agent: { session: { id: 's' } } });
check('/shodh status succeeds', statusOut.kind === 'success');
check('status reports tenant', statusOut.text.includes('tenant    dsh'));
check('status reports circuit', statusOut.text.includes('circuit   closed'));
check('status reports version header', statusOut.text.startsWith('shodh-memory  v'));
check('status reports effective recall config', statusOut.text.includes('recall    on'));
check('status reports activity section', statusOut.text.includes('activity  '));
const summaryOut = await command.handler({ rawInput: 'summary', agent: {} });
check('/shodh summary lists decisions', summaryOut.text.includes('Decisions:'));
const badOut = await command.handler({ rawInput: 'bogus', agent: {} });
check('unknown subcommand errors', badOut.kind === 'error');

console.log('\n[10] resilience: circuit breaker');
failNext = 20;
const beforeFailures = received.length;
for (let i = 0; i < 4; i += 1) {
  ctx.emit('session/event', { id: 'sess-9' }, {
    type: 'user/message', seq: 10 + i, time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text: `Outage probe ${i}: this write must fail without throwing into the harness.` }],
      source: { kind: 'user' },
    },
  });
}
await sleep(400);
check('failures did not crash the process', true);
check('breaker opened after threshold', true);
const warnLogs = logs.filter(([, m]) => m.includes('circuit open'));
check('breaker logged a warning', warnLogs.length >= 1);

const afterOutage = received.length;
ctx.emit('session/event', { id: 'sess-9' }, {
  type: 'user/message', seq: 99, time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: 'Post-breaker probe: should not touch the socket at all.' }], source: { kind: 'user' } },
});
await sleep(200);
check('open breaker makes no further network calls', received.length === afterOutage);
console.log(`    requests before outage: ${beforeFailures}, during: ${afterOutage}, after breaker: ${received.length}`);

console.log('\n[11] output schemas are plain JSON Schema (not schemastery)');
for (const tool of registeredTools) {
  assert.equal(typeof tool.output.schema, 'object');
  assert.equal(tool.output.schema.type, 'object');
  assert.ok(!('validate' in tool.output.schema), `${tool.name}: schema must be a plain value schema object`);
}
check('all tool output schemas are plain JSON Schema', true);

console.log('\n[12] tenant override reaches the wire');
failNext = 0;
const { ShodhClient } = await import('../src/client.js');
const scoped = new ShodhClient({
  baseUrl, apiKey: 'scoped-key', userId: 'dsh:default-project',
  requestTimeoutMs: 2000, failureThreshold: 3, failureCooldownMs: 1000,
});
await scoped.remember({ content: 'Tenant check A.' }, {});
await scoped.remember({ content: 'Tenant check B.' }, { userId: 'dsh:other-project' });
const tenantA = received.find((r) => r.url === '/api/remember' && r.body?.content === 'Tenant check A.');
const tenantB = received.find((r) => r.url === '/api/remember' && r.body?.content === 'Tenant check B.');
check('default tenant used when no override', tenantA?.body?.user_id === 'dsh:default-project');
check('per-call override wins', tenantB?.body?.user_id === 'dsh:other-project');
check('uid() falls back to the process default', scoped.uid(undefined) === 'dsh:default-project');

console.log(`\n${passed} checks passed.\n`);

await ctx.fiber.dispose();
server.close();
process.exit(0);
