// Render the real /shodh status dashboard against the live shodh container.
import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '/workspace/shodh-memory-dsh-integration/src/index.js';

const commands = [];
class ToolsStub extends Service { constructor(c){super(c,'tools'); this.register=()=>()=>{};} }
class CommandsStub extends Service { constructor(c){super(c,'commands'); this.register=(d)=>{commands.push(d);return()=>{};};} }
class SystemPromptStub extends Service { constructor(c){super(c,'systemPrompt'); this.section=()=>()=>{};} }
class SessionsStub extends Service { constructor(c){super(c,'sessions'); this.on=()=>()=>{};} }
class AgentsStub extends Service { constructor(c){super(c,'agents');} }

const ctx = new Context();
ctx.logger = { info:()=>{}, warn:()=>{}, debug:()=>{}, error:(m,...a)=>console.log('[err]',m,...a) };
new ToolsStub(ctx); new CommandsStub(ctx); new SystemPromptStub(ctx); new SessionsStub(ctx); new AgentsStub(ctx);

await plugin.apply(ctx, {
  baseUrl: 'http://shodh-memory:3030',
  apiKeyEnv: 'SHODH_API_KEY',
  userIdScope: 'workspace',
});

const cmd = commands.find((c) => c.name === 'shodh');
const out = await cmd.handler({ rawInput: 'status', agent: { session: { id: 'preview' } } });
console.log(out.text);
