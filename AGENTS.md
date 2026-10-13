# AGENTS.md — working rules for @louisremi/dsh-shodh-memory

Instructions for coding agents (and humans) working in this repository.
Read this before changing anything.

## Changes go through pull requests — always

**Never push directly to `main`.** Every change to this repository — code,
tests, docs, CI, config — must land through a pull request:

1. Branch from `main` (e.g. `fix/recall-budget`, `chore/bump-deps`).
2. Commit and push the branch.
3. Open a PR: `gh pr create` with a title and a body that says *what* changed
   and *why*.
4. Wait for CI to go green (checks are required; a failing check blocks the
   merge).
5. Merge with `gh pr merge` (squash or merge, matching the work).

`main` has branch protection that rejects direct pushes. Do not work around
it — if a push is rejected, the process above is the fix, not a force-push or
a protection change.

## Toolchain

- **pnpm** is the package manager (`packageManager` is pinned in
  `package.json`; `pnpm-lock.yaml` is committed). Never introduce npm/yarn
  lockfiles.
- **TypeScript** (strict, NodeNext). Source lives in `src/*.ts`; `pnpm build`
  emits `dist/` with declarations. `dist/` and `build/` are generated —
  never commit them.
- **Biome** owns lint + formatting + import order. Run `pnpm lint` before
  pushing; `pnpm lint:fix` applies safe fixes. CI fails on any finding.

```bash
pnpm install --frozen-lockfile
pnpm lint        # biome check .
pnpm run typecheck
pnpm run build   # tsc → dist/
pnpm test        # build + typecheck + format suite + smoke suite
```

## Hard constraints

- **Behavior is pinned by tests.** The smoke suite asserts the exact wire
  contract (endpoints, payloads, header names) and exact user-facing strings
  (`- [Type 91%] …`, `tenant    `, `circuit   closed`, the recall header,
  `'─'.repeat(44)`). Changing one is a product decision, not a refactor
  detail — update the pins deliberately and say so in the PR body.
- **Optional dependencies stay runtime-optional.** `src/` must not
  statically import `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, or
  `@deepseek-ai/dsh-llm`; they are dynamic-imported behind guards and typed
  through local structural interfaces in `src/types.ts`. Only tests may
  import them.
- **The published artifact is `dist/`.** Entry is `dist/index.js` via
  `exports`; `test/overlay.yml` and `deploy/*.mjs` also point there. After
  changing sources, rebuild before booting through the overlay.
- **Secrets never get committed.** npm publication goes through Trusted
  Publishing (OIDC, `id-token: write`) — this repo holds **no npm token at
  all**, in secrets or anywhere else. Do not add an `NPM_TOKEN`.
- **Node >= 18 is a supported runtime** (`engines`). Keep build targets at
  ES2022.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens PRs every Monday — `npm` for the
pnpm lockfile, `github-actions` for the workflows — and those PRs follow the
same rules as everything else above: they get reviewed by CI, never pushed.

- **Dev-dependency PRs merge themselves.** `auto-merge.yml` queues any PR
  whose changes are development dependencies only for squash-merge; the
  required `check` still gates it. Everything else — Actions bumps, any
  production or peer dependency change — waits for a human.
- **`@deepseek-ai/*` pins may float to alphas.** They are prereleases, so
  Dependabot proposes prereleases and auto-merge lands them when the smoke
  suite passes. Retargeting the `@deepseek-ai/cordis` **peer** range at a new
  harness line is still a human decision.
- **Bumps stay out of the release notes.** Dependency PRs carry
  `skip-changelog`, which `.github/release.yml` excludes.
- **The ecosystem is `npm`, not `pnpm`** — GitHub has no `pnpm` value and
  supports pnpm v7–v10. Re-check Dependabot support before moving
  `packageManager` past 10. And because `@deepseek-ai/*` are public packages,
  updates need no `registries:` credentials block: no `NPM_TOKEN`, ever.

## Releasing

Releases are automated: pushing a `v*` tag creates the GitHub release with
generated notes from the commits since the last tag, and the release is
published to npm by CI under the `@louisremi` scope, via Trusted Publishing
(OIDC). The tag must match the `package.json` version — CI enforces it — so
cut a release by bumping the version through a PR, then tagging. Do not
hand-roll `npm publish` from a laptop.
