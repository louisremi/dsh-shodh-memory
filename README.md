# dsh-shodh-memory

Native [shodh-memory](https://github.com/varun29ankuS/shodh-memory) integration for
DeepSeek Harness — persistent memory **without an MCP server in the context window**.

shodh ships two integration paths: Claude Code hooks and an MCP server. Neither
fits this harness. The MCP path registers 51 tool schemas into **every** model
request — roughly 7.5k tokens of standing overhead, paid on every turn forever,
for tools the model will mostly never call.

This plugin talks to the same server over its plain REST API and inverts that
ratio.

## Token cost

| | shodh MCP | this plugin |
|---|---|---|
| Tool schemas in every request | 51 (~7,500 tok) | 3 (~350 tok) |
| System-prompt guidance | — | 1 section (~150 tok) |
| Standing overhead | ~7,500 tok | **~500 tok** |
| Recall | model must call a tool | automatic, capped |
| Capture | model must call a tool | automatic, free |

Everything beyond those three tools happens without the model's involvement:
recall is driven by the turn's own prompt, capture is driven by session events.
Both are off the model's token ledger entirely.

## What it does

**Auto-recall.** At the first step of each turn, the user's prompt goes to
`/api/proactive_context` and the results come back as a bounded block:

```
Relevant memories (shodh):
- [Decision 91%] The profile uses pnpm with a hoisted node linker.
- [Error 74%] Sandbox denies writes outside the session workspace.
- [Learning 55%] Auto-recall block is capped at 1200 chars.
```

Three things keep this from becoming its own token problem: it fires **once per
turn** (not per step), it is **hard-capped** (`autoRecall.maxChars`), and a
**reuse gap** stops a memory from being re-injected while it is still sitting in
the context window.

**Auto-capture.** Human prompts and failed tool calls are stored in the
background. Zero model tokens, zero turn latency. Failed tool calls are the
highest-value automatic signal in a coding harness — "tried X, got this error"
is exactly what stops an agent re-running a known-bad command three sessions
later.

**Three tools.** The only things the model cannot do without help:

| Tool | Purpose |
|---|---|
| `memory_save` | Persist a decision, preference, constraint, or fix |
| `memory_search` | Go past the injected block when more is needed |
| `memory_forget` | Delete a memory that turned out to be wrong |

**`/shodh`** — human-facing control that costs the model nothing:

```
/shodh status            Server health, tenant, circuit state, plugin settings
/shodh save <text>       Store a memory as a Decision
/shodh search <query>    Semantic search across all sessions
/shodh summary           Recent decisions, learnings, and context
/shodh forget <id>       Delete one memory
```

## Install

Start shodh and expose its key:

```bash
shodh init && shodh server          # http://127.0.0.1:3030
export SHODH_API_KEY=<key from shodh init>
```

Add the plugin to a profile:

```bash
dsh plugin --profile web add <path-or-package>
```

The bundle declares `dsh.bundle.patch`, so the layer is applied automatically.
Do **not** also insert its row into your profile's `cordis.patch.yml` — duplicate
ids fail the loader.

## Configuration

All defaults live in [`cordis.patch.yml`](cordis.patch.yml), which is commented
in full. Override any of it by id in `$DSH_HOME/cordis.patch.yml` or a
`--patch` overlay. A patch replaces the row's whole `config`, so restate fields
you keep.

The knobs that matter most:

| Key | Default | Why you would change it |
|---|---|---|
| `userIdScope` | `global` | `workspace` namespaces memory per project directory, so "we use pnpm here" stops surfacing in an unrelated repo |
| `autoRecall.maxChars` | `1200` | The single biggest token-cost control on the injected block |
| `autoRecall.enabled` | `true` | Off = tools-only, near-zero standing cost |
| `autoCapture.assistantReplies` | `false` | High volume, low signal; leave off unless you want transcripts |
| `tools.*` | all `true` | Each toggle removes ~120 tokens from every request |
| `failureCooldownMs` | `30000` | How long a dead server is ignored before a probe |

## Failure posture

The memory server is an optional external process. Nothing here may make the
harness slower or less reliable because of it.

Every call is bounded by a timeout. Automatic paths swallow failures silently.
After `failureThreshold` consecutive failures a **circuit breaker** opens and
stops touching the socket entirely for `failureCooldownMs`, logging one warning.
With shodh down, the plugin is indistinguishable from not being installed.

The peer imports (`dsh-tools`, `dsh-llm`) are resolved independently and
defensively, because a plugin that throws on a missing peer takes the whole
profile down with it.

## Layout

```
package.json          dsh.bundle declaration
cordis.patch.yml      the bundle layer, fully commented
src/
  index.js          entry: name / inject / apply, wiring, prompt section
  config.js         normalization and clamping (no schema dep)
  client.js         REST over fetch, timeouts, circuit breaker
  format.js         text extraction, compact capped rendering
  capture.js       session-event → /api/remember
  recall.js        turn prompt → proactive_context → injected block
  tools.js         memory_save / memory_search / memory_forget
  commands.js      /shodh
test/
  smoke.mjs        44-check end-to-end test against a fake shodh
  overlay.yml      dev overlay for booting inside a real harness
```

## Development

```bash
node test/smoke.mjs
```

The smoke test boots a real cordis context with stub services against a fake
shodh HTTP server, then drives the same events the harness would and asserts on
what reached the wire — the contract, not the internals. It covers capture, the
no-feedback-loop guarantee, recall budgeting and reuse-gap, all three tools, the
slash command, breaker behaviour, and that tool output schemas are plain JSON
Schema rather than schemastery instances (which the registry rejects).

To boot it inside a real harness without publishing:

```bash
dsh --profile <name> --patch ./test/overlay.yml "hello"
```

The overlay points at the **entry file**, not the package directory: a bare
directory in a `--patch` overlay becomes a raw ESM directory import, which Node
rejects without consulting `package.json`. The `dsh plugin add` path is
unaffected — it installs into the profile's `node_modules` and resolves by name
through `exports`.

## Design notes

**Why `agent/pre-step` and not `systemPrompt.context` for recall.**
`systemPrompt.context` is the better seam for rarely-changing state: the loop
re-materializes it only when the rendered text changes, preserving the prompt
cache. It cannot be used here because its provider receives only the assembly
scope, never the user's message — and a recall that cannot see the question
cannot answer it.

**The one way to get `agent/pre-step` wrong.** Build the replacement from the
incoming `payload.messages`. The innermost default of that waterfall appends
the runtime-context message to the claimed batch; a listener that reconstructs
from the payload silently drops it and nothing reports the loss. Always
`await next()` first and modify **its result**. This mirrors first-party
`dsh-agent-instructions`.

**No feedback loop.** Captured text is filtered to `source.kind === 'user'`, and
recall queries are built only from human messages. Recalled text can therefore
never be re-remembered, which would otherwise turn the store into an echo
chamber.

**Config has no schema export.** Cordis validates config only when the runtime
exports a `Config` implementing the Standard Schema interface. Pulling in
schemastery for one document is not worth the dependency, so every field is
normalized and clamped in `config.js` instead, and unknown keys are ignored
rather than fatal — a mistyped override should never stop the harness from
booting.

## License

MIT
