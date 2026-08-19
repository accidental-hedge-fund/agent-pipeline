## Why

`detectAndInstall` only inspects the worktree-root lockfile. This repo has no root `package-lock.json` and keeps the lock under `core/`. Fresh worktrees therefore skip setup. Planning and implementing then start without `core/node_modules`.

On Ship milestone v1.39.4, issue #1096 implementing ran 40 minutes and hit the 2400s harness cap. The worktree had no `core/node_modules`. The first targeted test failed because `zod` was missing. The implementer then ran `npm ci` itself and burned the rest of the budget on hung `loop-supervisor` re-runs plus an in-harness `npm run ci`. Run `1096-2026-08-18T17-50-29-558Z` has no `#1096: worktree setup` line. Setup was skipped. #174 added root-lockfile install only. That path does not cover a nested `core/` lock.

This is a **class** defect in the shared setup detector, not a #1096 site mole and not a `setup_command` patch for this repo alone.

## What Changes

- After the existing root-lockfile miss, `detectAndInstall` SHALL inspect first-level subdirectories for a recognized lockfile and run the matching install with CWD set to that subdirectory.
- For this repo that means `npm ci` in `core/` before planning or implementing.
- Root-lockfile repos keep the #174 path. No change when the worktree root has `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.
- Nested idempotency is scoped to the detected package root (`core/node_modules`), not the worktree-root `node_modules` sentinel.
- `setup_command` override and empty-string opt-out stay first. They still run (or skip) at the worktree root.
- No change to the 2400s implementer cap. No change to Grok explorer spawning. No v1.40.0 `plugin/` delete.

## Acceptance Criteria

- [ ] Creating a worktree for this repo (no root lockfile, `core/package-lock.json` present, `core/node_modules` absent, `setup_command` unset) runs `npm ci` with CWD `core/` before planning or implementing starts.
- [ ] After that setup, `cd core && node --test --experimental-strip-types test/train.test.ts` can start without a mid-stage `npm ci`.
- [ ] A unit test of `detectAndInstall` fails when only `core/package-lock.json` exists and `core/node_modules` is not installed (the test bites without the nested-install path).
- [ ] A worktree with a root `package-lock.json` (or `pnpm-lock.yaml` / `yarn.lock`) and no `setup_command` still installs at the worktree root. Nested fallback does not run.
- [ ] A worktree-root `node_modules` directory does not skip install when the only lockfile is `core/package-lock.json` and `core/node_modules` is absent.
- [ ] When `core/node_modules` already exists and `setup_command` is unset, the nested install is skipped.
- [ ] Empty `setup_command` still skips auto-detect even when `core/package-lock.json` exists.
- [ ] Non-empty `setup_command` still runs at the worktree root and does not auto-detect a nested lockfile.
- [ ] A nested `npm ci` that exits non-zero still throws and blocks as `worktree-setup-failed`.
- [ ] Tests inject deps (no real network, git, or subprocess). After `core/` edits, `plugin/` is regenerated. `npm run ci` is green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `worktree-dependency-install`: After a root-lockfile miss, detect a first-level nested lockfile (the #1132 fixture is `core/package-lock.json`) and run the matching install in that directory. Scope the `node_modules` skip to the detected package root. Keep the #174 root-only path unchanged.
- `worktree-lifecycle`: A worktree-root `node_modules` directory is still not deleted at bootstrap. It SHALL NOT suppress nested install when the lockfile lives under a first-level package root such as `core/` and that package root has no `node_modules`.

## Impact

- **Class vs site:** Class is “setup auto-detect inspects only the worktree root, so a first-level nested lockfile skips install.” The #1096 `core/` miss and the 2400s implementer timeout are sites of that class. The shared change is `detectAndInstall` in `core/scripts/worktree-setup.ts`. The next repo whose lock lives under `core/` (or another single first-level package directory) MUST NOT need a new mole issue or a repo-local `setup_command`.
- **Shared gate, not recover recipe:** This is a bootstrap gate fix. It does not add a classifier, recovery recipe, or controller path. The next identical fault is prevented at setup, not recovered after a harness timeout.
- **Primary:** `core/scripts/worktree-setup.ts` and `core/test/worktree-setup.test.ts`. `bootstrapWorktree` in `core/scripts/stages/planning.ts` already calls `detectAndInstall`; no new call site. Eval fixture preflight inherits the same function.
- **Docs:** `docs/config.md` / README setup notes if they still say “lockfile in the worktree root” only.
- **Out of scope:** raising the 2400s implementer cap; recursive monorepo installs deeper than one directory (`packages/foo`); #837 reuse of `node_modules` on an identical lock; v1.40.0 `plugin/` delete; adding a `setup_command` for this repo as the only fix.
- **Program:** engine dogfood / ship-path recover. A path-local `setup_command: "cd core && npm ci"` in `.github/pipeline.yml` is not sufficient on its own.
