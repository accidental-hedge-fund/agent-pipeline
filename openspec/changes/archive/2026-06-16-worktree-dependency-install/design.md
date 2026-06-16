## Context

The pipeline's worktree bootstrap (`createWorktree`) fetches the base branch and checks out a fresh working tree, but stops there. For JS/TS repos that don't vendor `node_modules`, all binaries referenced by the test/build gate (e.g., `vitest`, `tsc`, `jest`) are absent. The test gate fails with `sh: vitest: command not found` rather than a test failure — a confusing, blocking error that the fix harness cannot meaningfully address (it correctly diagnoses the missing install, but has no hook to resolve it).

The fix must execute at worktree creation time so every subsequent stage sees a complete, runnable worktree. Bolting the install onto the test gate itself would be wrong: other stages (planning, fix harness, eval) also benefit from installed binaries, and deferring to the gate creates a tight coupling between two separate concerns.

## Goals / Non-Goals

**Goals:**
- Run dependency install automatically in every fresh worktree before any stage executes.
- Auto-detect the package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm).
- Expose a `setup_command` config key for operators who need more than a simple install (multi-step setup, monorepos, etc.).
- Skip gracefully when no lockfile and no `setup_command` are present (non-JS repos stay unaffected).
- Idempotent: skip the install if `node_modules` is already populated and no explicit `setup_command` is configured (fast-path for subsequent pipeline runs on the same worktree).
- Fail fast with a clear error if the install command exits non-zero (block at setup, not at test gate with a cryptic message).

**Non-Goals:**
- Supporting languages other than JS/TS in this change (Go, Rust, Python setup hooks are out of scope; a future `setup_command` can cover them).
- Auto-reinstalling when `package.json` changes mid-run (out of scope; the pipeline creates a new worktree per run).
- Running `npm audit`, `postinstall` suppression, or any optional install flags — plain install only.

## Decisions

### D1: Placement — worktree bootstrap, not a stage

The install step runs at the end of `createWorktree` (or in a thin `bootstrapWorktree` wrapper called immediately after) rather than inside any individual stage.

**Rationale**: stages are run in a loop and their order can shift; tying the install to one stage would re-run it unnecessarily on retry or miss it if a different stage runs first. Bootstrap is the canonical "worktree is now ready" boundary.

**Alternative considered**: run inside the test gate's pre-check. Rejected because it couples two orthogonal concerns and leaves other stages (e.g., fix harness) without binaries on their first invocation.

### D2: Idempotency check via `node_modules` presence

Skip install if `<worktree>/node_modules` exists AND `setup_command` is not explicitly set.

**Rationale**: subsequent pipeline runs on a live worktree (the loop re-enters without recreating the tree) must not pay the install overhead every tick. The `node_modules` sentinel is already the conventional indicator that install has been done.

**Alternative considered**: always run `pnpm install --frozen-lockfile` (idempotent by design). Rejected because it still takes several seconds on large repos and adds subprocess overhead on every loop iteration.

### D3: Config key is `setup_command` (string, optional)

A single optional string field in `.github/pipeline.yml`. Empty string (`""`) is the explicit opt-out.

**Rationale**: matches the shape of `test_gate.command` — operators already know this pattern. A boolean `skip_install` flag was considered and rejected: it gives no escape hatch for custom setup (e.g., `pnpm install --frozen-lockfile && pnpm build`).

**Parsing**: the command string is passed to `spawn` with `{shell: true}` (unlike `test_gate.command` which is whitespace-tokenized without shell). This is intentional: `setup_command` is expected to contain compound operators (`&&`, env vars, script paths).

### D4: Auto-detection precedence

`pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`. All checked in the worktree root only (not recursive). If multiple lockfiles are present the precedence above applies (pnpm wins).

**Rationale**: mirrors the existing precedence in `test-build-gate` command detection, keeping both subsystems consistent.

## Risks / Trade-offs

- **Slow install on large repos** → acceptable; installs are cached in pnpm/yarn/npm store. Not mitigated in this change; operators can use `setup_command: ""` to opt out if needed.
- **`node_modules` sentinel false-negative** → a partially-installed or corrupted `node_modules` folder is treated as "done". Mitigation: operators use `setup_command` to force a clean install.
- **Shell injection via `setup_command`** → the value comes from `.github/pipeline.yml` which is a repository-controlled file, so the threat model is the same as any other repository config. No additional sanitization is warranted.
- **Runs in a worktree (isolated directory)** → `spawn` CWD must be set to the worktree path, not the repo root. This is the same pattern already used for the test gate; implementation must follow that precedent.
