# dsh-shodh-memory

Persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
powered by [**shodh-memory**](https://github.com/varun29ankuS/shodh-memory) —
integrated natively as a plugin bundle, **without an MCP server in your context
window**.

> This project is an independent third-party integration. It is not affiliated
> with, endorsed by, or maintained by the shodh-memory authors. All credit for
> the memory engine itself belongs to
> [varun29ankuS/shodh-memory](https://github.com/varun29ankuS/shodh-memory) —
> see [Credits](#credits).

**Install:** `dsh plugin --profile web add dsh-shodh-memory`
(published to npm — [registry](https://www.npmjs.com/package/dsh-shodh-memory))

---

## Why not just use the MCP server?

shodh-memory ships two integration paths: Claude Code hooks and an MCP server.
Neither fits DeepSeek Harness well. The MCP path registers **51 tool schemas into
every model request** — roughly 7.5k tokens of standing overhead, paid on every
single turn, forever, for tools the model will mostly never call.

This plugin talks to the same server over its plain REST API and inverts that
ratio.

| | shodh MCP | this plugin |
|---|---|---|
| Tool schemas in every request | 51 (~7,500 tok) | 3 (~350 tok) |
| System-prompt guidance | — | 1 section (~150 tok) |
| **Standing overhead** | **~7,500 tok** | **~500 tok** |
| Recall | model must remember to call a tool | automatic, budget-capped |
| Capture | model must remember to call a tool | automatic, free |
| Transport | MCP session | plain HTTP |

<sub>Tool count taken from the 51 tools enumerated in the shodh-memory README
(`## 51 MCP Tools`); the project's docs site lists 45, which appears to be a
stale count. Either way the order of magnitude is the point.</sub>

Everything beyond those three tools happens without the model's involvement, so
it never touches the token ledger.

**A note on what is and isn't ours.** The memory engine — local embeddings,
entity extraction, the typed knowledge graph, Hebbian strengthening, decay,
spreading activation, the "no LLM in the loop" property — is entirely
shodh-memory's. This plugin is the plumbing that makes that engine usable from
DeepSeek Harness cheaply.

---

## Features

### Auto-recall

At the first step of each turn, the user's prompt is sent to shodh's
`/api/recall` endpoint and the results come back as a compact block:

```
Relevant memories (shodh):
- [Decision 91%] The profile uses pnpm with a hoisted node linker.
- [Error 74%] Sandbox denies writes outside the session workspace.
- [Learning 55%] Auto-recall block is capped at 1200 chars.
```

> **Why `/api/recall` and not `/api/proactive_context`.** The earlier design
> used `proactive_context`, which reads like the right endpoint for this. It is
> not: verified against a live shodh 0.2.0 server, `proactive_context` returns
> the correct response *shape* but always zero memories — on that version it
> surfaces reminders and todos, not stored memories. `/api/recall` is the
> endpoint that actually returns ranked memories. If you bump the server and
> auto-recall goes quiet, check this first.

Three mechanisms keep this from becoming its own token problem:

1. **Once per turn**, not per step — injecting on every tool round is where cost compounds.
2. **Hard-capped** by `autoRecall.maxChars` (default 1200 ≈ 300 tokens).
3. **Reuse gap** — a memory injected at turn *N* is not re-injected until turn *N+8*, so you never pay twice for text that is still sitting in the context window.

### Auto-capture

Human prompts and failed tool calls are stored in the background, off session
events. Zero model tokens, zero added turn latency.

Failed tool calls are the highest-value automatic signal in a coding harness:
"tried X, got this error" is exactly what stops an agent re-running a
known-bad command three sessions later.

### Three tools

The only things the model genuinely cannot do without help:

| Tool | Purpose |
|---|---|
| `memory_save` | Persist a decision, preference, constraint, or fix |
| `memory_search` | Go past the injected block when more context is needed |
| `memory_forget` | Delete a memory that turned out to be wrong |

Each is individually toggleable; every one you disable removes ~120 tokens from
every request.

### `/shodh` slash command

Human-facing control that costs the model nothing:

```
/shodh status            Server health, tenant, circuit state, plugin settings
/shodh save <text>       Store a memory as a Decision
/shodh search <query>    Semantic search across all sessions   (alias: find)
/shodh summary           Recent decisions, learnings, and context
/shodh forget <id>       Delete one memory                     (alias: delete)
/shodh help              Usage
```

Bare `/shodh` runs `status`.

---

## Requirements

| | |
|---|---|
| **DeepSeek Harness** | `dsh` 0.1.6-alpha.1 (developed against; earlier 0.1.x should work) |
| **shodh-memory** | Any build exposing the HTTP API — binary, Docker, or `shodh server` |
| **Node.js** | ≥ 18 (uses the global `fetch`) |
| **pnpm** | Required only for `dsh plugin add` |

The plugin has **no runtime dependencies**. It uses Node's built-in `fetch` and
`node:crypto`, and resolves the harness packages it needs from the profile
that's already loaded.

---

## Install

### The easy way — install from npm

The plugin is published to npm as **`dsh-shodh-memory`**. One command:

```bash
dsh plugin --profile web add dsh-shodh-memory
```

That's it. `dsh plugin add` installs the package into your profile's
`node_modules` and, because the package declares `dsh.bundle.patch`,
automatically joins the bundle layer stack — the patch layer, the three tools
(`memory_save`, `memory_search`, `memory_forget`), the `/shodh` command, and
the prompt section all come along. No build step, no manual wiring.

Update to the latest version later with:

```bash
dsh plugin --profile web update dsh-shodh-memory
```

The plugin has **no runtime dependencies**, so the install pulls in nothing
beyond the package itself.

---

### Full setup (first time)

The npm line above is the only step most people need. The rest is first-time
setup: getting a shodh-memory server running and pointing the plugin at it.

#### 1. Start shodh-memory

```bash
# Binary / brew
shodh init          # generates a config and an API key
shodh server        # serves the HTTP API on http://127.0.0.1:3030

# Or Docker
docker run -d -p 3030:3030 -v shodh-data:/data varunshodh/shodh-memory
```

Confirm it is up:

```bash
curl http://localhost:3030/health     # {"status":"ok"}
```

#### 2. Export the API key

The plugin reads the key from an environment variable (name configurable via
`apiKeyEnv`, default `SHODH_API_KEY`). `shodh init` prints the key it
generated.

```bash
export SHODH_API_KEY=<key from shodh init>
```

#### 3. Add the plugin to your profile

```bash
dsh plugin --profile web add dsh-shodh-memory
```

From a local checkout (for development, instead of the npm package):

```bash
dsh plugin --profile web add /path/to/dsh-shodh-memory
```

The package declares `dsh.bundle.patch`, so the bundle layer is applied
automatically and the plugin joins your profile's bundle stack.

> **Do not** also insert the `shodh-memory` row into your own
> `$DSH_HOME/cordis.patch.yml`. Duplicate bundle ids fail the loader. Your
> profile patch is for *overriding* the row, not adding it twice.

### 4. Verify

```bash
dsh --profile web --dump-config | grep -A 3 shodh-memory
```

Then in a session, run `/shodh status`.

---

## Usage

### Just work normally

With defaults, there is nothing to do. Memories surface at the start of each
turn; prompts and failures get captured.

### Save something deliberately

Ask the agent to remember a decision, or use the slash command:

```
/shodh save We pin Node 22 for the harness; 24 breaks the native build.
```

Good memories are **self-contained single statements**. They get read back out
of context later, so "we use pnpm here" is worth storing and "see above" is
worthless.

Good candidates:

- architectural decisions and the reasoning behind them
- user preferences and constraints
- environment quirks that are not written down anywhere
- fixes for problems that cost real time to diagnose

Poor candidates:

- anything readable from the repo — memory is for what the repo does *not* record
- transient task state
- secrets

### Search past sessions

```
/shodh search why did we switch to a hoisted node linker
```

### Check what's going on

```
/shodh status
```

```
tenant: dsh:my-project
server: http://127.0.0.1:3030
status: ok {"status":"ok"}
circuit: closed (0 consecutive failure(s))
store: total_memories=214 tier_ltm=180
recall: on (≤1200 chars, 5 memories/turn)
capture: on (prompts, tool errors)
tools: memory_save, memory_search, memory_forget
captured this process: 37
```

---

## Configuration

Every default lives in
[`cordis.patch.yml`](cordis.patch.yml), commented in full. Override any of it
by targeting the row `id: shodh-memory` in `$DSH_HOME/cordis.patch.yml` or a
`--patch` overlay.

> A patch **replaces the row's whole `config`** rather than merging into it, so
> restate every field you want to keep.

```yaml
# $DSH_HOME/cordis.patch.yml
- id: shodh-memory
  config:
    baseUrl: http://127.0.0.1:3030
    apiKeyEnv: SHODH_API_KEY
    userId: dsh
    userIdScope: workspace        # per-project memory namespaces
    autoRecall:
      enabled: true
      maxChars: 800
      maxResults: 4
    autoCapture:
      enabled: true
      toolErrors: true
    tools:
      save: true
      search: true
      forget: false
```

### The knobs that matter

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:3030` | shodh HTTP root. Env override: `SHODH_API_URL` |
| `apiKeyEnv` | `SHODH_API_KEY` | Name of the env var holding the key |
| `userId` | `dsh` | shodh tenant. Env override: `SHODH_USER_ID` |
| **`userIdScope`** | `global` | **`workspace` namespaces memory per project directory** |
| `autoRecall.maxChars` | `1200` | The single biggest token-cost control |
| `autoRecall.enabled` | `true` | Off = tools-only, near-zero standing cost |
| `autoRecall.reuseGapTurns` | `8` | Don't re-inject a memory still in context |
| `autoCapture.toolErrors` | `true` | The highest-value automatic capture |
| `autoCapture.assistantReplies` | `false` | High volume, low signal — leave off unless you want transcripts |
| `tools.*` | all `true` | Each toggle saves ~120 tok per request |
| `promptSection` | `true` | The ~150 tok usage-guidance section |
| `failureCooldownMs` | `30000` | How long a dead server is ignored before a probe |

### Recommended: per-project memory

`userIdScope: 'workspace'` namespaces memory by project directory, so a
decision made in one repo stops surfacing in an unrelated one. "We use pnpm
here" is not a fact about a different project.

This is **off by default** to keep the upgrade conservative, but it is the
setting most coding users should turn on.

---

## Privacy and data locality

Nothing in this plugin sends data anywhere that shodh itself would not.

- All traffic is to your configured `baseUrl` — loopback by default.
- No telemetry, no analytics, no third-party endpoints.
- The plugin stores no data of its own; the memory lives in shodh's store.
- shodh-memory is local-first and runs with no LLM in the loop and no cloud
  dependency — that property is the engine's, and this plugin preserves it.

If shodh is bound to loopback, memory never leaves the machine.

---

## Failure posture

The memory server is an optional external process. Nothing here may make the
harness slower or less reliable because of it.

- Every call is bounded by a timeout (`requestTimeoutMs`, `recallTimeoutMs`).
- Automatic paths swallow failures silently — a memory miss never surfaces as an error.
- After `failureThreshold` consecutive failures a **circuit breaker** opens and stops touching the socket entirely for `failureCooldownMs`, logging one warning.
- Peer imports (`dsh-tools`, `dsh-llm`) resolve independently and defensively, because a plugin that throws on a missing peer takes the whole profile down with it.

**With shodh down, the plugin is indistinguishable from not being installed.**

---

## Troubleshooting

**`no API key: set $SHODH_API_KEY`**
The plugin warned at startup and is sending unauthenticated requests. Run
`shodh init` and export the key, or point `apiKeyEnv` at whichever variable
holds it.

**`status: UNREACHABLE` in `/shodh status`**
shodh isn't running, or `baseUrl` is wrong. Check `curl http://localhost:3030/health`.

**`circuit: OPEN, retry in Ns`**
Expected after repeated failures. The plugin is deliberately not hammering a
dead server. It self-heals on the next successful probe — you'll see
`recovered; circuit closed`.

**Memories from the wrong project are showing up**
You're on `userIdScope: 'global'`. Switch to `workspace`.

**Recall feels noisy / irrelevant memories injected**
Lower `autoRecall.maxResults`, or lower `maxChars` so fewer lines fit.
Memories scoring below 0.2 relevance are already filtered out.

**Nothing is being captured**
Check `autoCapture.enabled`, and that `minChars` isn't above your typical
prompt length (default 24).

**`duplicate bundle id` on boot**
The `shodh-memory` row was added both by the bundle and manually to your
profile patch. Remove the manual one.

---

## Development

```bash
node test/smoke.mjs
```

The smoke test boots a real cordis context with stub services against a fake
shodh HTTP server, then drives the same events the harness would and asserts on
what actually reached the wire — the contract, not the internals. 44 checks
covering capture, the no-feedback-loop guarantee, recall budgeting and reuse
gap, all three tools, the slash command, circuit-breaker behaviour, tenant
scoping, and that tool output schemas are plain JSON Schema rather than
schemastery instances (which the registry rejects).

To boot the plugin inside a real harness without publishing it:

```bash
dsh --profile <name> --patch ./test/overlay.yml "hello"
```

The overlay points at the **entry file**, not the package directory: a bare
directory in a `--patch` overlay becomes a raw ESM directory import, which Node
rejects without consulting `package.json`. The `dsh plugin add` path is
unaffected — it installs into the profile's `node_modules` and resolves by name
through `exports`.

### Testing status — please read

The wire shapes in this plugin were derived by reading the **official
`@shodh/memory-mcp` 0.2.0 client source**, not by guessing, and the test suite
uses a faithful fake implementing those shapes.

**Verified against a live shodh server as of v0.1.1.** The plugin was booted
against a real `varunshodh/shodh-memory:0.2.0` container and exercised
end-to-end: `health`, `remember`, `recall` (returning the `.experience`-nested
shape `src/format.js` expects), `stats`, and `forget` all behaved as modelled,
and a real cordis `Context` boot registered `memory_save`, `memory_search`,
`memory_forget`, the `/shodh` command, and the prompt section. The reference
client and the running binary agree. If a future server version changes a shape,
`src/client.js` is still the single place to adjust.

---

## Design notes

**Why `agent/pre-step` and not `systemPrompt.context` for recall.**
`systemPrompt.context` is the better seam for rarely-changing state: the loop
re-materializes it only when the rendered text changes, preserving the prompt
cache. It cannot be used here because its provider receives only the assembly
scope, never the user's message — and a recall that cannot see the question
cannot answer it.

**The one way to get `agent/pre-step` wrong.**
Build the replacement from the incoming `payload.messages`. The innermost
default of that waterfall appends the runtime-context message to the claimed
batch; a listener that reconstructs from the payload silently drops it and
nothing reports the loss. Always `await next()` first and modify **its result**.
This mirrors first-party `dsh-agent-instructions`.

**No feedback loop.**
Captured text is filtered to `source.kind === 'user'`, and recall queries are
built only from human messages. Recalled text can therefore never be
re-remembered, which would otherwise turn the store into an echo chamber.

**Config has no schema export.**
Cordis validates config only when the runtime exports a `Config` implementing
the Standard Schema interface. Pulling in schemastery for one document is not
worth the dependency, so every field is normalized and clamped in `config.js`
instead, and unknown keys are ignored rather than fatal — a mistyped override
should never stop the harness from booting.

---

## Project layout

```
package.json          dsh.bundle declaration
cordis.patch.yml      the bundle layer, fully commented
src/
  index.js          entry: name / inject / apply, wiring, prompt section
  config.js         normalization and clamping (no schema dependency)
  client.js         REST over fetch, timeouts, circuit breaker
  format.js         text extraction, compact capped rendering
  capture.js        session events → /api/remember
  recall.js         turn prompt → /api/recall → injected block
  tools.js          memory_save / memory_search / memory_forget
  commands.js       /shodh
test/
  smoke.mjs         44-check end-to-end test against a fake shodh
  overlay.yml       dev overlay for booting inside a real harness
docs/
  research.md       sourced notes on the dsh plugin contract and peer plugins
```

---

## Credits

**[shodh-memory](https://github.com/varun29ankuS/shodh-memory)** by
[varun29ankuS](https://github.com/varun29ankuS) — the memory engine behind
this plugin.

Everything substantive about the memory itself is theirs: the LLM-free
architecture, local MiniLM embeddings via ONNX Runtime, GLiNER entity
extraction, typed relation extraction and the knowledge graph, causal lineage,
Hebbian strengthening, exponential→power-law decay, spreading activation,
long-term potentiation, and the three-tier working / session / long-term model
grounded in Cowan's working-memory research and Wixted's decay research.

- Repository: <https://github.com/varun29ankuS/shodh-memory>
- Documentation: <https://www.shodh-memory.com/docs>
- License: **Apache-2.0**
- Discord: <https://discord.gg/HrpzXqTtEp>

If this plugin is useful to you, the project worth starring is theirs.

**DeepSeek Harness** — <https://github.com/deepseek-ai/deepseek-harness> — for
the plugin framework this bundle plugs into.

This integration is itself a third-party work with no affiliation to either
project.

---

## License

MIT © the dsh-shodh-memory contributors

Integrates with shodh-memory, which is licensed under Apache-2.0. See
[Credits](#credits).
