// Confirm the recall counter moves when capture and recall share a tenant.
import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '/workspace/shodh-memory-dsh-integration/src/index.js';

const commands = [];
const byName = {};
class ToolsStub extends Service { constructor(c){super(c,'tools'); this.register=()=>()=>{};} }
class CommandsStub extends Service { constructor(c){super(c,'commands'); this.register=(d)=>{commands.push(d);return()=>{};};} }
class SystemPromptStub extends Service { constructor(c){super(c,'systemPrompt'); this.section=()=>()=>{};} }
class SessionsStub extends Service { constructor(c){super(c,'sessions');} }
class AgentsStub extends Service { constructor(c){super(c,'agents');} }

const ctx = new Context();
ctx.logger = { info:()=>{}, warn:()=>{}, debug:()=>{}, error:(m,...a)=>console.log('[err]',m,...a) };
ctx.on = (name, fn) => { (byName[name] ??= []).push(fn); return () => {}; };
new ToolsStub(ctx); new CommandsStub(ctx); new SystemPromptStub(ctx); new SessionsStub(ctx); new AgentsStub(ctx);

// global scope so capture (no agent) and recall (agent) share one tenant.
await plugin.apply(ctx, { baseUrl: 'http://shodh-memory:3030', apiKeyEnv: 'SHODH_API_KEY', userIdScope: 'global', userId: 'dsh-web' });

const text = 'podman not docker on this host remember that please';
for (const fn of byName['session/event'] ?? []) fn({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
await new Promise((r) => setTimeout(r, 1500));

const agent = { session: { id: 's1' } };
for (const fn of byName['agent/pre-step'] ?? []) {
  const decision = { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] };
  await fn({ step: 1, turn: 1, agent, signal: { aborted: false } }, async () => decision);
}

const cmd = commands.find((c) => c.name === 'shodh');
const out = await cmd.handler({ rawInput: 'status', agent });
console.log(out.text);
