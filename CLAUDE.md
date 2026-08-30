# agent-pipeline — working conventions

A self-contained TypeScript skill that advances a GitHub issue through a label-driven
state machine to `pipeline:ready-to-deploy`. It develops **itself** through this same
pipeline, so these conventions are what the pipeline's own planning / implementation /
review steps must follow.

## Golden rules (read first)

1. **The product is the `pipeline` CLI plus a short host SKILL.** Hosts are argv
   wrappers that exec the CLI. Edit `core/`. After any change under `core/`, run
   `node scripts/build.mjs` so `--check` can assert generated host SKILL freshness.
   Do not recreate or commit `plugin/`. CI fails if a generated host SKILL is
   stale (`node scripts/build.mjs --check`).
2. **`npm run ci` must pass before a change is done.** It runs: `ci:core` (`cd core && npm ci
   && npm test`) → `build.mjs --check` (host SKILL freshness) → `ci:install-smoke` →
   `ci:openspec` (`openspec validate --all` when an `openspec/` directory is present) →
   **conditional docs freshness** (`ci:docs`: no-op when the generator is absent; real
   `docs:check` / `generate-docs --check` when `scripts/generate-docs.mjs` is present) →
   `ci:scripts`. Green unit tests alone do not mask stale generated docs. GitHub Actions
   PR/main CI checks out **full history and tags** (`fetch-depth: 0`, `fetch-tags: true`) so
   tag-dependent generators match a full local clone. Run `npm run ci` from the repo root;
   treat a red `ci` as not-done.
3. **Rigor over latency.** This pipeline's product *is* its review rigor. Do not disable or
   default-demote review steps to go faster. Speed work must be rigor-preserving (better
   prompts, removing dead/deterministic asks, fixing real convergence bugs) — never by
   removing review coverage.
4. **Advance never merges.** `/pipeline N`, `pipeline single`, and `pipeline loop`
   stop at `pipeline:ready-to-deploy` and never invoke a merge. Merging uses
   loop-isolated, operator-authorized commands only: `pipeline merge` per PR,
   `pipeline merge-queue --apply` for a batch (`merge-queue` is dry-run by default),
   `pipeline train --merge`, or `pipeline ship --milestone` (no grant file).
   External supervisors may invoke those same commands under operator authority.
   This repository does not ship a Hermes/Buzz factory control plane, grant schema,
   or second durable scheduler. Merge authority is not repository configuration
   (`.github/pipeline.yml` cannot authorize merges). Do not add an `auto_merge`
   config key or a merge stage.
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
- `openspec/` — spec-driven-development specs (`specs/`) and in-flight changes (`changes/`).
- `scripts/` — `build.mjs` (host SKILL generate/check), `install.mjs`, `ci-install-smoke.mjs`.

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

## Concurrency scope (#459 / #634)

- The engine's host-local PID locks (`lock.ts`) — the **unified issue-run lock** used by both
  foreground advance and detach (keyed by **domain + issue**, path
  `/tmp/pipeline-{domain}-{N}.lock`; never issue-number-only), the queue-batch serialization, and
  the live-planning marker — are **host-local**: they provide mutual exclusion only between
  processes on the same machine, none across distinct hosts. **Single-host operation is the
  supported concurrency scope for these lock sites.** Each guards host-local state (one host's
  worktrees, run-state dir, detach wrapper runs, queue) whose cross-host failure mode is two hosts
  each doing their own thing in their own worktree — not a persistent, irreversible shared
  artifact — so this is a documented engineering disposition, not an oversight (see
  `openspec/changes/cross-host-auto-file-serialization/design.md` and
  `openspec/changes/detach-lock-domain-scope/design.md` for per-site assessment). Unifying advance
  and detach onto one domain+issue key does **not** expand the lock to cross-host scope.
- **Per-site dispositions (single-host):**
  - **Issue-run lock** (advance + detach): guards one host's worktrees / run-state / exclusive
    dispatch for `(domain, issue)`. Cross-host failure: two hosts advance the same issue in
    separate worktrees (GitHub labels last-writer-wins).
  - **Queue-batch serialization:** one host's queue/run-state; two hosts run overlapping batches
    independently.
  - **Live-planning marker:** one host's planning worktree for a repo+issue; two hosts plan on
    separate checkouts.
- **Exception: the auto-file path** (`autoFilePapercuts`, `autoFileCorrections`,
  `autoFileDurableRunBlockers` in `core/scripts/stages/papercut.ts`) is hardened to be
  **cross-host safe** for all three categories, because its failure mode — a duplicate or over-cap
  auto-filed GitHub issue — is exactly that kind of irreversible artifact. It uses GitHub-authored
  issue state (not the host-local lock) as the cross-host source of truth: each category’s
  independent per-window rate cap is recomputed from GitHub immediately before each create
  (marker-scoped open backlog count only; #631), and a post-create read-back closes duplicate
  titles and category-scoped rate-cap overflow down to the lowest-numbered open survivors. The
  `/tmp` lock is retained only as a same-host fast path.

## Conventions

- Simplicity first; find root causes, no temporary patches. Match surrounding code style.
- Worktrees live under `.worktrees/<branch-with-+>`; never make code changes on `main`.
- When instructions/docs/code/config disagree, surface the conflict with sources — don't average them.
