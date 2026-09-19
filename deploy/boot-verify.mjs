// Boot the real plugin inside a real cordis Context, pointed at the live shodh
// container on nasbrico, and report which tools/commands/prompt sections it
// registers. Uses the same Service-stub pattern as test/smoke.mjs.
import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '/workspace/shodh-memory-dsh-integration/src/index.js';

const tools = [];
const commands = [];
const sections = [];

class ToolsStub extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.register = (def) => {
      tools.push(def);
      return () => {};
    };
  }
}
class CommandsStub extends Service {
  constructor(ctx) {
    super(ctx, 'commands');
    this.register = (def) => {
      commands.push(def);
      return () => {};
    };
  }
}
class SystemPromptStub extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt');
    this.section = (s) => {
      sections.push(s);
      return () => {};
    };
  }
}
class SessionsStub extends Service {
  constructor(ctx) {
    super(ctx, 'sessions');
    this.on = () => () => {};
  }
}
class AgentsStub extends Service {
  constructor(ctx) {
    super(ctx, 'agents');
  }
}

const ctx = new Context();
ctx.logger = {
  info: () => {},
  warn: (m, ...a) => console.log('[boot][warn]', m, ...a),
  debug: () => {},
  error: (m, ...a) => console.log('[boot][error]', m, ...a),
};

new ToolsStub(ctx);
new CommandsStub(ctx);
new SystemPromptStub(ctx);
new SessionsStub(ctx);
new AgentsStub(ctx);

const config = {
  baseUrl: process.env.SHODH_BASE ?? 'http://shodh-memory:3030',
  apiKeyEnv: 'SHODH_API_KEY',
  userIdScope: 'workspace',
};

try {
  await plugin.apply(ctx, config);
  console.log('[boot] apply() completed');
} catch (e) {
  console.log('[boot] apply() THREW:', e?.message ?? e);
  process.exit(1);
}

const toolNames = tools.map((t) => t?.name ?? String(t));
console.log('[boot] tools:', JSON.stringify(toolNames));
console.log('[boot] commands:', JSON.stringify(commands.map((c) => c?.name ?? String(c))));
console.log('[boot] prompt sections:', sections.length);

const want = ['memory_save', 'memory_search', 'memory_forget'];
const missing = want.filter((t) => !toolNames.includes(t));
if (missing.length === 0) {
  console.log(`[boot] PASS all ${want.length} memory tools registered`);
  process.exit(0);
}
console.log(`[boot] FAIL missing: ${missing.join(', ')}`);
process.exit(1);
