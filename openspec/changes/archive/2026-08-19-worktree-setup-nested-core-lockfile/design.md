## Context

See `proposal.md` for motivation.

`detectAndInstall` in `core/scripts/worktree-setup.ts` currently:

1. Skips when `setup_command === ""`.
2. Runs `setup_command` via shell in the worktree root when it is non-empty.
3. Skips when `<worktree>/node_modules` exists.
4. Detects a lockfile only at the worktree root.
5. Skips when none is found.

This repo has no root lockfile. The lock and tests live under `core/`. Step 5 skips. `bootstrapWorktree` then logs no setup line. Planning and implementing start without `core/node_modules`.

Constraints:

- Class over site: fix the shared detector. Do not ship a repo-local `setup_command: "cd core && npm ci"` as the only change.
- Keep the #174 root-lockfile path byte-for-byte in behavior.
- Unit tests inject I/O. No real filesystem, network, or subprocess.
- Existing root-lockfile tests must keep passing without a mid-stage `npm ci` from the implementer.

## Goals / Non-Goals

**Goals:**

- Choose the package root (worktree root or exactly one first-level subdirectory) before the `node_modules` skip.
- Run the matching install with CWD set to that package root.
- Keep `setup_command` first, at the worktree root.
- Add a biting unit test for the `core/package-lock.json` fixture.

**Non-Goals:**

- Recursive monorepo installs (`packages/foo`).
- Installing every first-level lockfile directory when more than one exists.
- Raising the 2400s implementer cap.
- #837 reuse of `node_modules` on an identical lock.
- Changing `SETUP_TIMEOUT_MS` or the `worktree-setup-failed` blocker kind.
- A new recovery recipe or classifier. This is a setup-gate prevent, not a post-timeout recover.

## Decisions

### D1 — First-level nested fallback, not a `core/`-only mole

**Decision:** After a root-lockfile miss, inspect immediate children of the worktree root. If exactly one child contains a recognized lockfile, that child is the package root.

**Rationale:** The class is “the JS package lives in a first-level subdirectory, not the git root.” Hardcoding only `core/` would fix this repo and leave the next `app/` or `backend/` layout as a new mole. First-level-only stays bounded: this repo’s generated plugin lock is at `plugin/pipeline/skills/pipeline/core/package-lock.json` and MUST NOT be selected.

**Alternatives considered:**

- Repo-local `setup_command` only → rejected. Site mole. The next nested-lock repo repeats #1096.
- Recurse the whole tree → rejected. Hits the generated plugin lock and arbitrary nested packages.
- Hardcode `core/` only → rejected as class-incomplete. `core/` remains the required fixture and the production layout of this repo.

### D2 — Choose package root before the `node_modules` skip

**Decision:** Evaluate idempotency against `<packageRoot>/node_modules`, after the package root is chosen. A worktree-root `node_modules` does not skip a nested install.

**Rationale:** Today step 3 runs before lockfile detection. A root `node_modules` (postinstall, leftover, or unrelated) would keep skipping `core/` even after D1. That is the same skip class.

**Alternatives considered:**

- Keep the root `node_modules` skip, then add nested detection only when it is absent → rejected. The lifecycle spec currently treats root `node_modules` as “install already done.” That rule is wrong when the lock lives under `core/`.

### D3 — One nested package root, else skip

**Decision:** If two or more first-level children have lockfiles, skip auto-detect without error. Operators set `setup_command`.

**Rationale:** Auto-installing every child is a different class (multi-package monorepo). Failing closed would newly block repos that today skip. Skip preserves the old behavior for that shape.

**Alternatives considered:**

- Install every first-level lockfile dir → out of issue scope; can hang setup on generated or example packages.
- Fail closed on multiple → behavior change for monorepos that previously skipped.

### D4 — Listing seam, with `core/` always probed

**Decision:** Add an optional directory-list seam on `SetupDeps` (same injection style as `existsSync` / `spawnCommand`). After a root miss, list first-level names when the seam (or real `fs`) succeeds. Always also probe `core/` so the #1132 fixture works with `existsSync`-only fakes. Ignore `.git`, `node_modules`, and names that start with `.`. If listing throws, treat the list as empty and still probe `core/`.

**Rationale:** Current tests inject `existsSync` only. A required real `readdir` on `/wt` would throw and skip nested install, or would need every existing test updated. Always probing `core/` keeps the required fixture simple. Production still lists real children so `app/` and similar layouts are covered.

**Alternatives considered:**

- Require `readdir` in every test → noisy churn of the #174 suite.
- Probe only `core/` and skip listing → D1 regresses to a site mole.

### D5 — Root lockfile still wins; `setup_command` still root CWD

**Decision:** If the worktree root has a recognized lockfile, install there and stop. Nested fallback does not run. Non-empty `setup_command` still runs via shell with CWD = worktree root and still bypasses detection. Empty `setup_command` still skips, including the nested path.

**Rationale:** Issue done-when item 4: “Root-only lockfile repos (the #174 case) still install at the root. No change to that path.”

## Risks / Trade-offs

- **Multiple first-level lockfiles still skip** → accepted. Those repos already skipped. Document `setup_command`. Not this issue.
- **`core/` always probed** → a repo that named a non-package directory `core/` and put a lockfile there would install. Same as selecting that child via listing. Unlikely.
- **Nested `npm ci` duration** → same 5-minute setup cap as root install. The #1096 burn was the implementer doing `npm ci` *inside* the 2400s harness, not setup itself.
- **Root `package.json` without a root lockfile** → this repo has that shape. Nested fallback is the correct install. Do not run root `npm ci` without a lockfile.

## Migration Plan

- Land in `detectAndInstall` and the existing `bootstrapWorktree` call site. No config migration.
- Repos with a root lockfile see no behavior change.
- This repo’s next worktree create runs `npm ci` in `core/` during setup. Fresh implementing does not need a mid-stage `npm ci`.
- Rollback: revert the detector. `setup_command` remains available as an operator override, not as the class fix.

## Open Questions

None. Deeper-than-first-level monorepos stay on `setup_command` by design.
