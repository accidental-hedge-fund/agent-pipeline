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
4. **No autonomous merges.** The advance loop stops at `pipeline:ready-to-deploy`.
   Merging happens only through explicit operator invocation (`pipeline merge` per-PR;
   `merge-queue --apply` batch, dry-run default); the invoking operator is the
   session-bound merge authority. There is no `auto_merge` config key and no
   unattended merge path — don't add either. Unattended merge remains gated on
   #662's shadow-calibrated evidence standard.
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
