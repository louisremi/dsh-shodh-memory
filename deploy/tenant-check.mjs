// Verify the workspace tenant sanitizer produces shodh-legal ids and that a
// workspace-scoped remember actually lands on the live server.
import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '/workspace/shodh-memory-dsh-integration/src/index.js';

const tools = [];
class ToolsStub extends Service { constructor(c){super(c,'tools'); this.register=(d)=>{tools.push(d);return()=>{};};} }
class CommandsStub extends Service { constructor(c){super(c,'commands'); this.register=()=>()=>{};} }
class SystemPromptStub extends Service { constructor(c){super(c,'systemPrompt'); this.section=()=>()=>{};} }
class SessionsStub extends Service { constructor(c){super(c,'sessions'); this.on=()=>()=>{};} }
class AgentsStub extends Service { constructor(c){super(c,'agents');} }

const ctx = new Context();
ctx.logger = { info:()=>{}, warn:(m,...a)=>console.log('[warn]',m,...a), debug:()=>{}, error:(m,...a)=>console.log('[err]',m,...a) };
new ToolsStub(ctx); new CommandsStub(ctx); new SystemPromptStub(ctx); new SessionsStub(ctx); new AgentsStub(ctx);

await plugin.apply(ctx, {
  baseUrl: 'http://shodh-memory:3030',
  apiKeyEnv: 'SHODH_API_KEY',
  userIdScope: 'workspace',
});

// Find the save tool and invoke it with an agent whose cwd has a space.
const save = tools.find((t) => t?.name === 'memory_save');
const marker = 'tenant-space-check-' + Date.now();
const res = await save.execute(
  { content: marker, type: 'Decision' },
  { agent: { workspaceCwd: '/workspace/My Project With Spaces' } },
);
console.log('[tenant] save result:', JSON.stringify(res).slice(0, 200));
const ok = res?.saved === true && typeof res?.id === 'string';
console.log(ok ? '[tenant] PASS workspace-scoped save accepted' : '[tenant] FAIL ' + JSON.stringify(res).slice(0,160));
process.exit(ok ? 0 : 1);
