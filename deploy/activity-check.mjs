// Drive a capture + recall through the real plugin, then confirm the activity
// counters in /shodh status actually moved.
import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '/workspace/shodh-memory-dsh-integration/src/index.js';

const commands = [];
const sessionListeners = [];
const preStepHandlers = [];
class ToolsStub extends Service { constructor(c){super(c,'tools'); this.register=()=>()=>{};} }
class CommandsStub extends Service { constructor(c){super(c,'commands'); this.register=(d)=>{commands.push(d);return()=>{};};} }
class SystemPromptStub extends Service { constructor(c){super(c,'systemPrompt'); this.section=()=>()=>{};} }
class SessionsStub extends Service {
  constructor(c){super(c,'sessions'); this.on=(ev,fn)=>{sessionListeners.push(fn);return()=>{};};}
}
class AgentsStub extends Service {
  constructor(c){super(c,'agents');}
}

const ctx = new Context();
ctx.logger = { info:()=>{}, warn:()=>{}, debug:()=>{}, error:(m,...a)=>console.log('[err]',m,...a) };
// capture uses ctx.on('session/event') and ctx.on('tools/result'); recall uses ctx.on('agent/pre-step').
// Route them by event name.
const byName = {};
ctx.on = (name, fn) => { (byName[name] ??= []).push(fn); return () => {}; };
new ToolsStub(ctx); new CommandsStub(ctx); new SystemPromptStub(ctx); new SessionsStub(ctx); new AgentsStub(ctx);

await plugin.apply(ctx, {
  baseUrl: 'http://shodh-memory:3030',
  apiKeyEnv: 'SHODH_API_KEY',
  userIdScope: 'workspace',
});

// 1. Fire a human prompt event -> should capture.
const promptText = 'the deployment uses podman not docker on this host, remember that please';
for (const fn of byName['session/event'] ?? []) {
  fn({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] } });
}
// let the capture queue drain
await new Promise((r) => setTimeout(r, 1500));

// 2. Fire a pre-step with a matching prompt -> should recall.
const agent = { session: { id: 's1' }, workspaceCwd: '/workspace/activity-test' };
for (const fn of byName['agent/pre-step'] ?? []) {
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }] };
  await fn({ step: 1, turn: 1, agent, signal: { aborted: false } }, async () => decision);
}

// 3. Read the dashboard.
const cmd = commands.find((c) => c.name === 'shodh');
const out = await cmd.handler({ rawInput: 'status', agent });
console.log(out.text);
const a = out.text.match(/activity\s+(\d+) captured.*?(\d+) recalled/);
console.log(a ? `\n[activity] captured=${a[1]} recalled=${a[2]}` : '\n[activity] counters NOT found');
