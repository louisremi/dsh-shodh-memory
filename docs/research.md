# Research: Authoring a DeepSeek Harness (dsh) plugin that integrates an external memory server

All facts below were read from live sources on 2026-09 (URLs cited inline). Nothing is invented; 404s and caveats are noted.

---

## 1. Official dsh plugin authoring docs

**Docs site:** https://deepseekplugin.com/docs — "dsh is an open-source agent harness where everything is a plugin — models, tools, sessions, sandboxes, the loop, and the UI." The site states its pages are "Adapted from the MIT-licensed deepseek-harness source" and mirror `master` of https://github.com/deepseek-ai/deepseek-harness (each page footers link to the repo source, e.g. `docs/user/develop/basic/index.md`). The upstream repo README points to the official docs site https://deepseek-harness.github.io/deepseek-harness/ (https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md).

### 1.1 Plugin module shape (https://deepseekplugin.com/docs/your-first-plugin)

> "In Harness, a plugin is a TypeScript module that exports an **apply** function. The framework calls apply when loading the plugin and passes a **ctx** context object through which the plugin registers capabilities."

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

Dependencies are declared with `inject`; the framework waits for every required service before calling apply:

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools is ready here.
  ctx.tools.register(/* ... */)
}
```

Three forms are documented: function module (above), object form (`export default { name, inject, apply(ctx) {...} }`), and class form (`export default class MyService extends Service { static inject = ['tools']; constructor(ctx) { super(ctx, 'myService') } }` — "super(ctx, 'myService') registers the plugin as ctx.myService").

Cleanup: "Anything registered through ctx — event listeners, tools, or timers — is cleaned up when the plugin unloads." Explicit resources use `ctx.effect(() => { ...; return () => dispose() })`.

Local dev loading (patch overlay):

```yaml
# scratch-plugin/cordis.yml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```
```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```
"The plugin path must be absolute. A patch file contributes configuration but does not change the profile directory from which the loader resolves module paths."

### 1.2 Bundle manifest — `dsh.bundle.patch` (https://deepseekplugin.com/docs/build-a-plugin)

> "A **bundle** is an npm package that ships a configuration layer. Its manifest declares dsh.bundle, answering 'what does this package contribute?' — a patch file that inserts or overrides plugin rows. A **profile** is a directory under $DSH_HOME/profiles/ describing one runnable composition. Its manifest declares dsh.profile."

Minimal bundle layout (quoted from the doc):

```text
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml — "plugin rows reference the package by name instead of a
# relative source path so Node resolution finds the installed code"
- insert:
    - id: hello
      name: dsh-hello-plugin
```

"A package without the dsh.bundle declaration still installs, but only as a plain dependency: dsh plugin prints a warning and activates no layer."

**Loading order** (later layers win per row; "a patch replaces a row's entire config value rather than deep-merging keys"):
1. Each bundle patch named in the profile's `dsh.profile.bundles` list, in list order (`@deepseek-ai/dsh-base` first, then each installed bundle in the order added)
2. The profile's own `cordis.patch.yml`
3. Home-level `$DSH_HOME/cordis.patch.yml`
4. Each `--patch` overlay, in argv order

**Git installs:** "a git install fetches sources, not built artifacts… The author ships a `prepare` script — pnpm runs it after a git install… The user allowlists the build. pnpm ≥10 refuses to run a git dependency's prepare script until it is explicitly allowed… copy the exact package key pnpm printed into the profile's pnpm-workspace.yaml: `allowBuilds: dsh-hello-plugin: true`".

**Directory listing:** "tag the repo with the `dsh-plugin` topic and it will be picked up by this directory's scanner."

### 1.3 Config schema and defaults (https://deepseekplugin.com/docs/plugin-config)

> "Export a Config type and a same-named Schemastery schema. Put defaults directly on the schema fields" — the plugin then "receives validated configuration through apply(ctx, config)".

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)  // User value or schema default.
}
```

Config supplied on the patch row:

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

Caveat from the doc: "Do not export a plain object as Config — it does not implement the Standard Schema interface Cordis requires." Also: "The Config export is a named schema the loader reads at load time — it is not the plugin's `inject` list."

### 1.4 Lifecycle (https://deepseekplugin.com/docs/plugin-lifecycle)

Fiber state machine: `PENDING → LOADING → ACTIVE / FAILED`, `ACTIVE → UNLOADING → DISPOSED`. `ctx.plugin(child)` creates a child fiber with independent lifecycle; `await fiber.dispose()` removes all registrations and recursively unloads children. HMR via `@deepseek-ai/cordis-plugin-hmr`: config/source edits unload the old instance and re-run `apply` with no stale registrations.

### 1.5 Events (https://deepseekplugin.com/docs/events)

- Live Cordis events use `namespace/action` names: `agent/step`, `agent/request`, `agent/request-error`, `tools/result`, `session/event`, etc. Dispatch modes: `emit` (fire-and-forget), `bail`, `serial`, `waterfall` (around-middleware via `next()`).
- **Durable session events** (`turn/*`, `step/*`, `tool/call`, `tool/result`, `compaction/*`) "are recorded in the session log… They are _not_ events you emit or observe directly. To observe a durable event, listen to `session/event` and inspect `event.type`":

```ts
ctx.on('session/event', (event) => {
  if (event.type === 'tool/result') { /* durable record */ }
})
```

### 1.6 System-prompt seam (https://deepseekplugin.com/docs/subsystems/system-prompt)

`ctx.systemPrompt` assembles "ordered **prompt sections**, dynamic **contexts**, **tool schemas** … and **variables**". Two registration contracts:

```ts
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}

interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}
```

Key token-cost fact: `PromptContext` is "the cache-safe counterpart to PromptSection… the agent loop logs their complete current snapshot as a durable user-role message after retained model history **only when it changed** or compaction removed it." "An empty `text` contributes nothing."

### 1.7 Extension cookbook / feature→mechanism map (https://deepseekplugin.com/docs/cookbook/extension-cookbook)

The map row for memory: **"Memory | section provider + tool"**. Other relevant rows:
- Hook system: "listeners on `agent/session-start`, `agent/pre-step`, `agent/request`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping`; waterfalls return typed decisions"
- Tool registration: "Built-in tools | `ctx.tools.register()`; schemas flow into the assembly automatically"
- System prompt configurability: "`ctx.systemPrompt.section()` with ordering and scope-local shadowing"
- Plugin hot-reload: "every registration is a `ctx.effect` → vendored HMR just works"

Hook gate guidance: `ctx.tools.guard()` for monotonic final denial; `tools/execute` to wrap dispatch lifetime; `tools/post-execute` for result transformation; `tools/result` for observation; `tools/pre-execute` for allow/deny decisions (`{ kind: 'deny', reason: ... }` or `next()`).

### 1.8 Upstream repo (https://github.com/deepseek-ai/deepseek-harness)

- README confirms "everything-is-a-plugin" architecture, Cordis-powered, developer preview with breaking changes, `npx @deepseek-ai/dsh web` quickstart, `dsh-plugin` GitHub topic for discoverability.
- `.agents/` directory exists in the repo (tree page https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents returns HTTP 200; GitHub's HTML listing was truncated so individual filenames were not extracted). README also references `AGENTS.md`.
- Docs source files cited by the mirror: `docs/user/develop/basic/index.md`, `docs/user/develop/basic/publish.md`, `docs/user/develop/basic/config.md`, `docs/user/develop/framework/index.md`, `docs/user/develop/framework/events.md`, `docs/cookbook/extension-cookbook.md`, `docs/subsystems/system-prompt.md`.

### 1.9 Ground truth from the local dsh install (this machine)

- CLI package: `/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json` — `@deepseek-ai/dsh` v0.1.6-alpha.1, `bin: { dsh: lib/bin.js }`, repo directory `apps/cli`.
- Real bundle example: `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/package.json`:

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

- Real `cordis.patch.yml` row format (from dsh-base, showing `id`, `name`, `disabled`, `config`, and `!!js` expressions):

```yaml
# The dsh-base bundle patch: the shared core of each base-backed profile, applied as
# ONE insert over the empty profile root. Later bundle patches and the user's
# profile cordis.patch.yml address these rows by id, with the last write
# winning per row.
#
# A patch replaces the targeted row's whole `config` rather than merging into it...
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']

    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
```

- The dsh README (local `/usr/local/lib/node_modules/@deepseek-ai/dsh/README.md`) documents entry modes: `dsh --profile <name>`, `dsh web`, `dsh plugin --profile <name> <pnpm args>` ("Manage a profile's plugins by forwarding to pnpm in the profile directory"), `--dump-config` / `--dump-default-config` to inspect the composed tree without booting. It also notes `config/examples/` ships "opt-in overlays for … memory MCP servers".

---

## 2. Real community memory plugins (read from actual source)

### 2.1 Graph Memory — adoresever/graph-memory (TypeScript, ★620, installable)

- Directory page: https://deepseekplugin.com/plugins/adoresever-graph-memory
- `package.json`: https://raw.githubusercontent.com/adoresever/graph-memory/main/package.json — declares:

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```
with `"exports": { ".": "./dist/index.js", "./dsh": "./dist/dsh.js", ... }` (dual-host: OpenClaw `index.ts` + DSH `dsh.ts`), `main: dist/index.js`, `type: module`, peer-deps `@deepseek-ai/cordis >=4` (optional).

- `cordis.patch.yml`: https://raw.githubusercontent.com/adoresever/graph-memory/main/cordis.patch.yml — one row with a rich config:

```yaml
- insert:
    - id: graph-memory
      name: 'graph-memory/dsh'
      config:
        dbPath: !!js dshHomePath('graph-memory/graph-memory.db')
        extractionEnabled: true
        recallEnabled: true
        recallMaxNodes: 6
        # Automatic recall is the default path and needs no tool schema.
        # Set to search for gm_search, or all for administrative tools.
        assistantTools: none
        maintenanceInterval: 6
        llmProvider: !!js process.env.GRAPH_MEMORY_LLM_PROVIDER
        llmModel: !!js process.env.GRAPH_MEMORY_LLM_MODEL
        ...
        embedding:
          apiKeyEnv: !!js "process.env.GRAPH_MEMORY_EMBEDDING_API_KEY ? 'GRAPH_MEMORY_EMBEDDING_API_KEY' : undefined"
          baseURL: !!js process.env.GRAPH_MEMORY_EMBEDDING_BASE_URL
          model: !!js process.env.GRAPH_MEMORY_EMBEDDING_MODEL
```

- Main plugin source `dsh.ts`: https://raw.githubusercontent.com/adoresever/graph-memory/main/dsh.ts — module exports:

```ts
export const name = "graph-memory-dsh";
export const inject = ["tools", "llm", "systemPrompt", "agentLoop", "agents", "sessions", "credentials", "tokenMeter"];

export function apply(ctx: DshContext, input: Config = {}): void { ... }
```

`apply(ctx, config)` structure (paraphrased from the actual source):
1. Validate every config field manually with `TypeError` throws (note: **no Schemastery export** — plain TS interface + `?? default` in apply works in practice).
2. Open SQLite (`openDb`), build `Recaller`, resolve embedding credentials via `ctx.credentials.resolve(credentialRef)`.
3. Register tools conditionally: `ctx.tools.register({ name: "gm_status" | "gm_search" | "gm_record" | "gm_stats" | "gm_maintain" | "gm_retry_extraction", ... })` — gated by `assistantTools` config (`none` default → zero tool schemas).
4. Listen to durable events:

```ts
ctx.on("session/event", (session: any, event: any) => {
  ...
  if (event?.type === "turn/end") {
    const turn = Number(event.data?.turn);
    if (Number.isInteger(turn) && turn > 0) captureCompletedTurn(session, turn, Number(event.seq));
    void scheduleExtract(id, turn);   // one auxiliary LLM call per committed turn
    maintain(id);
    if (Number.isInteger(turn) && turn > 0) projectCompletedTurn(session, turn, Number(event.seq));
  }
});
```

5. Attach per-agent pre-step waterfall for recall + rolling compaction:

```ts
agent.ctx.on("agent/pre-step", compactBeforeStep, { prepend: true });
...
ctx.on("agent/created", ({ agent }: any) => attachRollingCompaction(agent));
ctx.on("agent/session-start", ({ agent }: any) => { attachRollingCompaction(agent); restoreRoutes(agent); });
```

Inside `compactBeforeStep`, recall results are injected as a synthetic user message before the current user message:

```ts
const recalledMessage = {
  id: randomUUID(),
  role: "user",
  source: { kind: "plugin", plugin: PLUGIN, form: "snapshot",
    sections: [{ name: "graph-memory:recall", text }] },
  content: [{ type: "text", text }],
};
return { kind: "enter", messages: entered };
```

6. Auxiliary LLM extraction uses `ctx.llm.stream({ provider, model, reasoningEffort, system, tools: [GRAPH_EXTRACTION_TOOL], messages, signal })` — "Each committed DSH turn is one extraction job containing only the original user question and the final visible assistant answer. Tool traffic and reasoning are never sent to the extraction model."
7. Cleanup: `ctx.effect(() => async () => { ...abort controllers, await chains, db.close() }, "graph-memory.close")`.

- Install (from its README/directory page): `npx @deepseek-ai/dsh plugin --profile web add github:adoresever/graph-memory#v1.6.0-beta.16` then `npx @deepseek-ai/dsh --profile web --dump-config`.

### 2.2 Memory Evolve — csyangwen/dsh-memory-evolve (plain JS ESM, ★307, installable)

- Directory page: https://deepseekplugin.com/plugins/csyangwen-dsh-memory-evolve
- `package.json`: https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/package.json — declares both bundle and client manifests:

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime"],
    "platform": "web"
  },
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

- `cordis.patch.yml`: https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/cordis.patch.yml:

```yaml
# Install with `dsh plugin --profile <name> add <path-or-git-url>`; the bundle
# patch is applied automatically, so do NOT insert this row again in the
# profile patch (duplicate ids crash the loader).
- insert:
    - id: dsh-memory-evolve
      name: 'dsh-memory-evolve'
```

- Main source `lib/index.js`: https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/lib/index.js — module docstring:

> "Pure plugin: only public seams (`systemPrompt`, `tools`, `commands`, `subagents`, `approval`), zero DSH core changes, zero runtime dependencies. … The snapshot is injected as a `systemPrompt` context: DSH materializes it as a user-role tail message and only re-appends when the rendered text changes, so the stable system/history prefix (and its cache) is preserved."

Exports:

```js
export const name = 'dsh-memory-evolve'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionTitle', 'sessionPersistence', 'settings', 'llm']
```

(Comment in source: "cordis 限制：未声明的服务直接读会抛 'cannot get property xxx without inject'" — undeclared services throw without inject.)

Snapshot injection (actual code, ~line 1685 of lib/index.js):

```js
if (config.injectMemory) {
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({
        name: 'memory:snapshot',
        order: config.snapshotOrder,          // default 500
        text: (context) => {
          const runtime = getRuntime()
          return renderSnapshot(runtime, store, context.agent, counter, ctx.sessionTitle, writeGap)
        },
      })
    } catch (error) {
      // idempotency guard (issue #23): skip on "already registered"
      if (error instanceof Error && error.message.includes('already registered')) { ... return () => {} }
      throw error
    }
  }, 'dsh-memory-evolve: memory snapshot')
}
```

Tools and commands:

```js
ctx.effect(() => ctx.tools.register(memoryTool(ctx, config, store, queue, getRuntime, archive, writeGap)), 'dsh-memory-evolve: memory tool')
ctx.effect(() => ctx.tools.register(skillManageTool(ctx, config)), 'dsh-memory-evolve: skill tool')

ctx.inject(['commands'], (cmdCtx) => {
  cmdCtx.commands.register(reviewCommand(config, store, todoStore, archive, queue, ...))
  cmdCtx.commands.register(searchDocsCommand(config, {...}))
})
```

Config: a plain `export const DEFAULTS = { ... }` object (memoryDir null → `<dshHome>/memories`, `injectMemory: true`, `snapshotOrder: 500`, `toolName: 'memory'`, `suggestToolName: 'memory_suggest'`, `commandName: 'memory_review'`, `reviewEnabled: false`, ~80 keys) plus a hand-rolled `validateRuntimePatch(key, value)` switch for runtime changes persisted to a state file. Optional services are read with `ctx.get('workspaceRegistry')` and degraded explicitly (headless bundles don't provide web-only services).

### 2.3 deja-vu — vshulcz/deja-vu (JS, ★813, installable)

- Directory page: https://deepseekplugin.com/plugins/vshulcz-deja-vu
- `package.json` (repo root; plugin lives in `extensions/dsh`): https://raw.githubusercontent.com/vshulcz/deja-vu/main/package.json:

```json
"name": "dsh-deja",
"main": "./extensions/dsh/index.js",
"dsh": {
  "bundle": {
    "patch": "./extensions/dsh/cordis.patch.yml"
  }
}
```
(installable from a bare git URL or `github:vshulcz/deja-vu#path:extensions/dsh`)

- `extensions/dsh/cordis.patch.yml`: https://raw.githubusercontent.com/vshulcz/deja-vu/main/extensions/dsh/cordis.patch.yml — minimal:

```yaml
- insert:
    - id: deja
      name: dsh-deja
```

- Plugin source `extensions/dsh/index.js`: https://raw.githubusercontent.com/vshulcz/deja-vu/main/extensions/dsh/index.js — uses the **default-export function with attached inject**:

```js
function apply(ctx, config) {
  const adds = contributions({ command: installedByCLI("command.js"), auto: installedByCLI("auto.js") }, config);
  if (adds.tools) tools(ctx);
  if (adds.command) command(ctx);
  if (adds.recall) { autoDigest(ctx); autoRecall(ctx); }
}

apply.inject = ["tools", "commands", "systemPrompt"];

export default apply;
```

Tools registered with the typed helper from the host (`@deepseek-ai/dsh-tools`), imported defensively:

```js
let defineTool = null;
try { ({ defineTool } = await import("@deepseek-ai/dsh-tools")); } catch {}
...
guarded(() => ctx.tools.register(defineTool({
  name: "deja_recall",
  description: "Search this machine's own past AI coding sessions ...",
  parameters: { query: { type: "string", required: true, ... }, limit: { type: "number", ... } },
  output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
  execute(args) { ... }
})));
```
Tool comment: "The schema is plain JSON Schema — a schemastery instance is rejected as 'schema must be a value schema object', because the host validates that this is an ordinary JSON record."

Slash command:

```js
guarded(() => ctx.commands.register({
  name: "deja",
  description: "Search this machine's past AI coding sessions",
  input: { hint: "what to look for" },
  async handler(invocation) {
    const query = String((invocation && invocation.rawInput) || "").trim();
    ...
    return { kind: INSTALLED ? "success" : "error", text: answer(out) };
  },
}));
```

Auto-recall via the system-prompt context seam (with a crucial warning about why NOT to use pre-step):

```js
guarded(() => ctx.systemPrompt.context({
  name: "deja:recall",
  order: 120,
  text: (assembly) => {
    const agent = assembly && assembly.agent;
    if (!agent) return "";
    const prompt = lastHumanText(agent);
    ...
    return recalled;  // "" when nothing relevant — "Silence is the common case"
  },
}));
```

> "autoRecall puts the answer in front of the model without anyone asking for it, through the seam the host evaluates on every assembly. The obvious alternative — splicing a message into the 'agent/pre-step' waterfall — looks like it works and does not: a later listener rebuilds its answer from the payload, and the added message is dropped with nothing reported."

And on duplicate registration: "the host throws 'prompt context deja:recall is already registered' on a second copy in the same profile, and that failure is not local: the whole profile fails to load."

### 2.4 Mnemon — mnemon-dev/mnemon (★576)

- **Caveat:** `main` branch 404s (`https://raw.githubusercontent.com/mnemon-dev/mnemon/main/package.json` → 404). Default branch is `master`.
- `package.json`: https://raw.githubusercontent.com/mnemon-dev/mnemon/master/package.json — a meta-bundle `@mnemon-dev/dsh-mnemon` that depends on `dsh-mnemon` and declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
- `cordis.patch.yml`: https://raw.githubusercontent.com/mnemon-dev/mnemon/master/cordis.patch.yml:

```yaml
- insert:
    - id: mnemon
      name: dsh-mnemon
      config:
        routingGuidance: true
        lifecycleEnabled: true
        recallMode: guided
        writebackMode: guided
        idleReviewMs: 30000
        tabEnabled: true
        writeEnabled: true
        timeoutMs: 10000
        defaultRecallLimit: 10
```

### 2.5 memsearch — zilliztech/memsearch (★2.6K; Python core + JS dsh sub-package)

- **Caveat:** the repo root has **no** `package.json` (`https://raw.githubusercontent.com/zilliztech/memsearch/main/package.json` → 404; it's a Python monorepo). The directory page (https://deepseekplugin.com/plugins/zilliztech-memsearch) notes the root "doesn't declare a dsh.bundle". The actual dsh plugin is the sub-package `@zilliz/memsearch-dsh`.
- `plugins/dsh/package.json`: https://raw.githubusercontent.com/zilliztech/memsearch/main/plugins/dsh/package.json:

```json
"name": "@zilliz/memsearch-dsh",
"type": "module",
"main": "index.js",
"exports": { ".": {...,"default": "./index.js"}, "./client": "./client.js", "./cordis.patch.yml": "./cordis.patch.yml", ... },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
},
"peerDependencies": { "@deepseek-ai/dsh-llm": "*" }
```
Files include `prompts/`, `skills/`, and Python scripts (`summarize.py`, `parse-transcript.py`, `maintenance-runner.py`) — the plugin shells out to the Python `memsearch` CLI.
- Install (from its README): `uv tool install "memsearch[onnx]"` then `dsh plugin --profile web add @zilliz/memsearch-dsh`.
- Runtime per README: "Completed turns are captured automatically, and relevant memories are injected before the first model step only when they are useful." Recall is exposed as a registered `memory-recall` **skill** rather than many tools. Markdown files are the source of truth; Milvus is a rebuildable shadow index.

---

## 3. Install / registration commands (verified)

```sh
# Install a bundle into a profile (forwards to pnpm in $DSH_HOME/profiles/<name>):
dsh plugin --profile demo add ./hello-plugin
dsh plugin --profile demo add github:you/hello-plugin
dsh plugin --profile web add @zilliz/memsearch-dsh
npx @deepseek-ai/dsh plugin --profile web add github:adoresever/graph-memory#v1.6.0-beta.16

# Remove (dependency + layer):
dsh plugin --profile demo remove dsh-hello-plugin

# Inspect the composed config tree without booting:
dsh --profile demo --dump-config        # shows a "# == dsh-hello-plugin" layer

# Boot:
dsh web                               # alias of --profile web
dsh --profile demo

# Local dev overlay (no bundle):
pnpm dsh web --patch ./scratch-plugin/cordis.yml

# pnpm >=10 git-install build allowlist (profile's pnpm-workspace.yaml):
allowBuilds:
  dsh-hello-plugin: true
```

First use of `dsh plugin --profile <name> add ...` initializes the profile with `@deepseek-ai/dsh-base` as its first bundle and appends your package to `dsh.profile.bundles` (quoted from build-a-plugin doc).

---

## 4. What a dsh memory plugin does at runtime (cross-plugin pattern)

**Hooks used (all observed in real source):**

| Seam | API | Used for |
|---|---|---|
| Tool registration | `ctx.tools.register(defineTool({...}))` or raw JSON-Schema `ToolDefinition` | explicit recall/record/status tools (gm_search, deja_recall, memory) |
| Durable turn capture | `ctx.on('session/event', (session, event) => ...)` with `event.type === 'turn/end'` / `'user/message'` | enqueue extraction of the completed turn; capture model route from `request/header` |
| Agent lifecycle | `ctx.on('agent/created', ...)`, `ctx.on('agent/session-start', ...)` | attach per-agent hooks on resume/create |
| Per-step recall/compaction | `agent.ctx.on('agent/pre-step', fn, { prepend: true })` (waterfall, returns `{kind:'enter', messages}`) | graph-memory's recall + rolling compaction (deja-vu warns this is fragile for injection — prefer systemPrompt.context) |
| System prompt (dynamic) | `ctx.systemPrompt.context({ name, order, text: (assembly) => string })` | the auto-injected memory snapshot/recall block; empty string = no injection; re-materialized only when changed (cache-safe) |
| System prompt (static) | `ctx.systemPrompt.section()` with ordering | guidance sections (per cookbook "Memory = section provider + tool") |
| Slash commands | `ctx.commands.register({ name, description, input: {hint}, handler })` | `/memory_review`, `/deja` |
| Auxiliary LLM | `ctx.llm.stream({ provider, model, system, tools, messages, signal })` | background extraction/summarization with a dedicated lightweight route |
| Credentials | `ctx.credentials.resolve(ref)` | embedding API keys without putting secrets in config |
| Optional services | `ctx.get('name')` / scoped `ctx.inject(['commands'], cb)` | degrade when a service (e.g. web-only `workspaceRegistry`) is absent |
| Cleanup | `ctx.effect(() => { ...; return () => dispose() })` | close DBs, abort streams; auto-runs on unload/HMR |

**Token-cost strategies observed:**
1. **Auto-inject a small recall block instead of tools**: graph-memory defaults `assistantTools: none` — "Automatic recall is the default path and needs no tool schema" (zero tool-schema tokens). deja-vu and memory-evolve inject via `systemPrompt.context` whose text is `""` when nothing is relevant ("Silence is the common case").
2. **Cache preservation**: `PromptContext` snapshots are re-appended only when the rendered text changes, preserving the stable system/history prefix and provider prompt cache (memory-evolve docstring + system-prompt subsystem doc).
3. **Cheap extraction**: one auxiliary LLM call per committed turn, fed only the user question + final answer, never tool traffic/reasoning (graph-memory); memsearch summarizes via its own Python summarizer and injects "only when they are useful".
4. **Bounded recall**: `recallMaxNodes: 6`, `defaultRecallLimit: 10`, deja caps limit at 20 ("asking for a hundred sessions would spend the model's context on a tail nobody reads").
5. **Context takeover / rolling compaction**: graph-memory keeps the newest N (default 5) user turns and replaces older model-surface prefixes with one archive marker, "model-free: no DSH compaction/summarization request" (measured −80.69% first-request context at T20 in its benchmark).
6. **Skills instead of tools**: memsearch exposes recall as a registered `memory-recall` skill (loaded on demand) rather than always-visible tool schemas.
7. **Feature-flag everything off**: memory-evolve keeps ~20 optional subsystems behind default-off switches because "注册即占模型工具列表" (registering occupies the model's tool list).

---

## 5. Exact minimal file layout for a dsh memory bundle (synthesized from verified sources)

```text
my-dsh-memory/
├── package.json
├── cordis.patch.yml
└── index.js            (or dist/index.js built from src/)
```

**package.json** (required fields):
```json
{
  "name": "dsh-my-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```
Optional web client half (memory-evolve / memsearch pattern): `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] } }` plus a `./client` export.
For TS packages installed from git: add a `prepare` script that builds `main` (turtle-ui pattern per the build-a-plugin doc).

**cordis.patch.yml**:
```yaml
- insert:
    - id: my-memory            # stable row id; later layers override by id
      name: dsh-my-memory      # package name (Node resolution) or absolute path for local dev
      disabled: false          # optional; dsh-base uses `disabled: true` for dormant rows
      config:                  # whole-value replaced per layer, not deep-merged
        serverUrl: http://localhost:8787
        recallLimit: 6
        # JS expressions allowed via !!js tag:
        dbPath: !!js dshHomePath('my-memory/db.sqlite')
```

**index.js** (module exports):
```js
export const name = 'my-memory'
export const inject = ['tools', 'systemPrompt', 'agents']   // wait for these services

// Documented path: Schemastery schema for validation + defaults
// (graph-memory instead uses a plain interface + manual defaults — also works)
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({
  serverUrl: Schema.string().default('http://localhost:8787'),
  recallLimit: Schema.number().default(6),
})

export function apply(ctx, config) {
  // 1. auto-recall block (cache-safe, silent when empty):
  ctx.systemPrompt.context({
    name: 'my-memory:recall',
    order: 120,
    text: (assembly) => recallFor(assembly.agent) || '',
  })
  // 2. capture on committed turns:
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') enqueueExtraction(session, event.data.turn)
  })
  // 3. optional explicit tool:
  ctx.tools.register({ name: 'memory_search', ... })
  // 4. cleanup runs automatically on unload/HMR:
  ctx.effect(() => () => closeConnection())
}
```

---

## 6. 404s / caveats encountered (honesty list)

- `https://raw.githubusercontent.com/mnemon-dev/mnemon/main/package.json` → **404** (default branch is `master`, which works).
- `https://raw.githubusercontent.com/zilliztech/memsearch/main/package.json` → **404** (Python monorepo; the dsh bundle is `plugins/dsh/package.json` = `@zilliz/memsearch-dsh`, which exists).
- GitHub's HTML tree page for `deepseek-harness/.agents` loads (HTTP 200) but the rendered listing was truncated by GitHub chrome; individual `.agents/` filenames were not extracted.
- deepseekplugin.com is a third-party curated directory; its docs are mirrors of the official repo docs (each page cites the repo source path). The official docs site is https://deepseek-harness.github.io/deepseek-harness/.
- The dsh docs are explicitly "Developer preview… there will be compatibility-breaking changes."
- Real-world deviation from docs: only the docs use Schemastery `Config` exports; graph-memory, memory-evolve, and deja-vu all pass plain objects with manual defaults/validation through `apply(ctx, config)`.
