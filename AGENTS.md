# agent-pipeline — Codex working conventions

Codex subprocesses (`codex exec -C <worktreeDir>`) load this file for repo
conventions. Keep it in sync with `CLAUDE.md`.

## Golden rules (read first)

1. **Edit `core/`, never `plugin/` directly.** `plugin/` is a generated mirror
   of `core/` (+ `hosts/claude`). After **any** edit to a file under `core/`,
   run `node scripts/build.mjs` from the repo root and include the regenerated
   `plugin/` in the **same commit**. A core-only commit that forgets the mirror
   fails CI's `build.mjs --check` gate and burns a fix-loop attempt.
2. **`npm run ci` must pass before a change is done.** It runs: `ci:core`
   (`cd core && npm ci && npm test`) → `build.mjs --check` (mirror in sync) →
   `ci:install-smoke` → `ci:openspec` (`openspec validate --all` when an
   `openspec/` directory is present) → **conditional docs freshness** (`ci:docs`:
   no-op when the generator is absent; real `docs:check` / `generate-docs --check`
   when `scripts/generate-docs.mjs` is present) → `ci:scripts`. Green unit tests
   alone do not mask stale generated docs. GitHub Actions PR/main CI checks out
   **full history and tags** so tag-dependent generators match a full local clone.
   Treat a red `ci` as not-done.
3. **Rigor over latency.** Do not disable or default-demote review steps.
4. **Advance never merges.** `pipeline advance`, `pipeline single`, and
   `pipeline loop` stop at `pipeline:ready-to-deploy` and never invoke a merge.
   Merging uses loop-isolated, operator-authorized commands only: `pipeline merge`
   per PR, `pipeline merge-queue --apply` for a batch (`merge-queue` is dry-run
   by default), `pipeline train --merge`, or `pipeline ship --milestone` (no
   grant file). External supervisors may invoke those same commands under operator
   authority. This repository does not ship a Hermes/Buzz factory control plane,
   grant schema, or second durable scheduler. Merge authority is not repository
   configuration (`.github/pipeline.yml` cannot authorize merges). Do not add an
   `auto_merge` config key or a merge stage.
5. **Verify external shapes; never guess.** Confirm `gh --json` field names with
   a real call before coding against them.

## Layout

- `core/scripts/` — the engine (TypeScript, no build step).
- `plugin/` — **generated** mirror; do not hand-edit.
- `hosts/` — per-host packaging.
- `scripts/build.mjs` — generates / checks the mirror.

## Build & test

Run tests from `core/`: `node --test --experimental-strip-types test/*.test.ts`.
Full gate from repo root: `npm run ci`.

`npm run ci` also runs `openspec validate --all` when an `openspec/` directory is
present. A structurally invalid living spec or active change fails the gate.
The same full gate always includes a **conditional** docs freshness step
(`ci:docs`): no-op when the generator is absent; real check-mode when present —
so stale generated docs fail the same local command CI runs, without requiring
the generator on every branch. Actions PR/main checkout uses full history and
tags for parity with a full local clone when tag-sourced generators exist.

New features need unit tests; bug fixes need a regression test that would have
caught the bug. Tests inject I/O via `deps`/`Deps` seams — no real network, git,
or subprocess calls in unit tests.

## Concurrency scope (#459 / #631 / #634)

- Host-local PID locks are **single-host** only: the **unified issue-run lock** (advance +
  detach, keyed by domain+issue — never issue-number-only), queue-batch serialization, and
  live-planning marker. No cross-host mutual exclusion claim; single-host is the supported
  concurrency scope. Same-host multi-repo correctness uses domain in the issue-run key so
  issue `N` in domain A does not collide with issue `N` in domain B.
- **Exception:** all three auto-file categories (`autoFilePapercuts`,
  `autoFileCorrections`, `autoFileDurableRunBlockers`) share one **cross-host-safe**
  path: GitHub-authored issue state for pre-create dedup/rate-cap, plus post-create
  reconciliation. Each category has an **independent** `auto_file_max_per_window`
  budget scoped to its own provenance marker.
