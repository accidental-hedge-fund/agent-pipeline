# agent-pipeline — working conventions

A self-contained TypeScript skill that advances a GitHub issue through a label-driven
state machine to `pipeline:ready-to-deploy`. It develops **itself** through this same
pipeline, so these conventions are what the pipeline's own planning / implementation /
review steps must follow.

## Golden rules (read first)

1. **Edit `core/`, never `plugin/` directly.** `plugin/` is a generated mirror of `core/`
   (+ `hosts/claude`). After any change under `core/`, regenerate it:
   `node scripts/build.mjs`, and commit the regenerated `plugin/` in the same change. CI
   fails the build if the mirror is stale (`node scripts/build.mjs --check`). A core-only
   commit that forgets the mirror is the single most common wasted review/CI round.
2. **`npm run ci` must pass before a change is done.** It runs: `ci:core` (`cd core && npm ci
   && npm test`) → `build.mjs --check` (mirror in sync) → `ci:install-smoke` →
   `ci:openspec` (`openspec validate --all` when an `openspec/` directory is present). Run it
   from the repo root; treat a red `ci` as not-done.
3. **Rigor over latency.** This pipeline's product *is* its review rigor. Do not disable or
   default-demote review steps to go faster. Speed work must be rigor-preserving (better
   prompts, removing dead/deterministic asks, fixing real convergence bugs) — never by
   removing review coverage.
4. **The pipeline never merges.** It stops at `pipeline:ready-to-deploy`; a human owns the
   merge button. There is no auto-merge path and no `auto_merge` config key — don't add either.
5. **Verify external shapes; never guess.** Especially `gh --json` field names: confirm the
   real output (`gh pr view N --json <field>`) before coding against it. Guessing gh field
   shapes has caused multiple wasted review rounds.

## Layout

- `core/scripts/` — the engine (Node 24+ TypeScript, run via native type-stripping, **no build
  step**). `pipeline.ts` (CLI + loop), `config.ts`, `gh.ts` (typed `gh` wrappers), `harness.ts`,
  `profile.ts`, `review-policy.ts`, `stages/*.ts` (one file per stage: planning, review, fix,
  pre_merge, eval, deploy_ready, auto_recover), `prompts/*.md` (templates with `{{placeholders}}`).
- `core/test/` — co-located `*.test.ts`.
- `hosts/` — per-host packaging (`claude`, `codex`, `_shared`); the SKILL.md variants live here.
- `plugin/` — **generated** mirror (do not hand-edit).
- `openspec/` — spec-driven-development specs (`specs/`) and in-flight changes (`changes/`).
- `scripts/` — `build.mjs` (generate/check the mirror), `install.mjs`, `ci-install-smoke.mjs`.

## Build & test

- Tests: `node --test --experimental-strip-types test/*.test.ts` (from `core/`). Run all via
  `npm test` (core) or `npm run ci` (full gate) from root. There is **no `tsc` step** — types are
  stripped, not checked, so a type-only guarantee (e.g. `Record<keyof I, …>`) is NOT enforced at
  runtime; back such invariants with a real runtime test.
- New features need unit tests of the core logic; bug fixes need a regression test that would have
  caught the bug. Prove the test bites (it should fail without the fix).
- Tests inject I/O via dependency seams (a `deps`/`Deps` parameter with `gh`/harness/worktree
  fakes) — see `AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps`. Unit tests do **no real network,
  git, or subprocess** calls. Mirror this pattern for new stage logic.
- **Injectable-dep rule (hard):** Any new code path that calls an external CLI or API (`gh`,
  `openspec`, `git`, `getGhActor`, etc.) MUST be reachable via an injectable dep — never call
  the module-level function directly when a seam already exists on the `Deps` type. If no seam
  exists, add one. Tests that only pass because local `gh auth` is active are **not passing
  tests** — they will fail in CI. Verify every new test covers the unauthenticated / no-network
  path by proving it fails without the injected fake.

## OpenSpec

If working an OpenSpec change: author/keep exactly one change under `openspec/changes/<id>/`
(`proposal.md`, `design.md`, `tasks.md`, `specs/<capability>/spec.md` deltas). Every requirement
needs `SHALL`/`MUST` and at least one `#### Scenario:`; lead the requirement text with the subject +
`SHALL` (a wrapped second-line `SHALL` can fail strict validation). Pre-merge archives the change
into the living specs and runs `openspec validate --all` — a structurally invalid change blocks
`ready-to-deploy`.

## Review layer & convergence (hard-won)

- Review runs `reviewMode: prompt-harness` by default: the reviewer CLI is invoked directly with a
  JSON-returning prompt; the verdict JSON schema is single-sourced (`review-schema.ts` →
  `{{schema_block}}`) and drift-guarded by a test. Keep prompts and the schema constant in sync.
- The pre-merge **review-SHA gate (#16)** re-reviews only when a *developer/fix* commit lands after a
  verdict; the pipeline's own commits (`docs:`/`chore: archive OpenSpec …`) are classified internal
  and do **not** invalidate the verdict (`isPipelineInternalCommit`). Do not regress this to
  "re-review on any SHA change" — it caused a non-converging cascade.
- A `review_policy` (severity `block_threshold` + `min_confidence`) governs which findings block vs.
  advise; `--override "<key>: <reason>"` records an audited disposition. Use these instead of looser
  reviews.
- When a reviewer finding is out of an issue's stated scope, defer it to a tracked follow-up issue
  rather than expanding the change — but if the reviewer reliably re-flags a real design smell, fix
  the smell (don't fight the reviewer).
- **Surgical-fix discipline** (`fix.md`, #235): fix rounds SHALL make the **minimal diff** that
  resolves the specific finding — no refactors, scope-broadening, unrelated changes, or opportunistic
  cleanup. When a fix touches a destructive/irreversible operation (`git worktree remove --force`,
  `git push --force`, branch/worktree deletion, the merge surface), the prompt requires an explicit
  safety scope or written justification confirming the operation is scoped to the **managed worktree
  root** or the **reviewed head**. Before committing, the harness performs a pre-commit self-check:
  if the diff appears to introduce a higher-severity problem than the finding it resolves, it surfaces
  the concern and withholds the push. All three disciplines are drift-guarded by tests in
  `prompt-loader.test.ts`.

## Conventions

- Simplicity first; find root causes, no temporary patches. Match surrounding code style.
- Worktrees live under `.worktrees/<branch-with-+>`; never make code changes on `main`.
- When instructions/docs/code/config disagree, surface the conflict with sources — don't average them.
