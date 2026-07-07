## Why

The first live Hermes/local-worker run of `agent-pipeline` on an OpenSpec repo blocked at the
implementation test gate with `Worktree has uncommitted changes before the test gate ran`. The
dirty file was `openspec/config.yaml` — the OpenSpec **project config** that the `openspec` CLI
creates lazily (`ensureDefaultConfig` writes `schema: spec-driven` when the file is absent) the
first time a command like `openspec new change` or `openspec validate` runs in an
already-initialized repo. Our planning prompt runs exactly those commands, but the authoring
harness commits only `openspec/changes/<id>/`, so `config.yaml` is left **untracked**. The scoped
OpenSpec salvage only fires when the harness produced *no* commit, so when the harness *did*
commit the change, the stray `config.yaml` survives untracked into the test gate and trips the
dirty-tree block.

Two defects compound: (1) a legitimate, foundational OpenSpec project-config file is left
untracked by the planning/setup path, and (2) the dirty-tree block reason names no paths, so the
operator had to SSH into the worker and inspect the worktree by hand to discover what was dirty.

## What Changes

- **OpenSpec planning commits the project config it creates.** After the OpenSpec authoring
  harness runs (and after any scoped salvage), the planning stage SHALL commit
  `openspec/config.yaml` when the CLI left it untracked or modified in the worktree, so OpenSpec
  setup leaves no untracked project-config file before implementation or the test gate. The commit
  is scoped to `openspec/config.yaml`, carries the `Issue:`/`Pipeline-Run:` trailers, and satisfies
  the existing authoring path-constraint guard (the file is under `openspec/`). When the file is
  already tracked/committed, the step is a no-op. The `openspec.bootstrap` path is unchanged — it
  already commits `config.yaml` via `openspec init` + `git add -A`.
- **The test-gate dirty-tree block names the offending paths.** When the test/build gate blocks
  because the worktree is dirty (either before the first run or because a passing run left
  artifacts), the `blockReason` SHALL include the offending paths from `git status --porcelain`,
  truncated to a bound, so the operator sees *what* is dirty without inspecting the worktree.

## Capabilities

### Modified Capabilities

- `openspec-integration`: spec-first planning SHALL commit the OpenSpec project config
  (`openspec/config.yaml`) the CLI creates, leaving the worktree free of untracked OpenSpec
  project config before implementation/the test gate.
- `test-build-gate`: the dirty-worktree block SHALL include the offending `git status --porcelain`
  paths (truncated) in its `blockReason`.

## Impact

- `core/scripts/stages/planning.ts` — the OpenSpec authoring path (`makeOpenspecPlanningHooks` /
  `authorArtifact`): add a step that commits a leftover untracked/modified `openspec/config.yaml`
  after authoring + salvage, before the path-constraint verify.
- `core/scripts/testgate.ts` — the two dirty-tree block sites (`runTestGate`): surface the
  `git status --porcelain` paths in the block reason; add a `gitStatusPorcelain` (or equivalent)
  dependency seam so the path list is unit-testable without real git.
- `core/test/` — new regression tests under `planning.test.ts`/`testgate.test.ts` (or dedicated
  files) covering both behaviors; tests MUST bite (fail without the fix).
- `plugin/` mirror — regenerated via `node scripts/build.mjs` after the `core/` change.

## Acceptance Criteria

- [ ] After OpenSpec planning runs in an already-initialized repo where the `openspec` CLI created
  `openspec/config.yaml` untracked, `git status --porcelain` in the worktree reports **no**
  untracked or modified `openspec/config.yaml` — the file is committed.
- [ ] The commit that tracks `openspec/config.yaml` is scoped to that file (the diff contains no
  path outside `openspec/`) and carries `Issue: #<n>` and `Pipeline-Run: <id>` trailers; it passes
  the existing authoring path-constraint guard (`allowPattern: /^openspec\//`).
- [ ] When `openspec/config.yaml` is already tracked and unmodified after authoring, the planning
  stage creates **no** extra commit for it (the step is a no-op) and does not error.
- [ ] The `openspec.bootstrap` path (uninitialized repo) is unchanged: `openspec init` + `git add
  -A` still commits `config.yaml` in the `chore: openspec init` commit.
- [ ] When the test/build gate blocks because the worktree is dirty before the first run, the
  `blockReason` contains the offending path(s) from `git status --porcelain` (e.g.
  `?? openspec/config.yaml`), truncated if the list is long.
- [ ] When a passing test/build run leaves the tree dirty, that block reason likewise includes the
  offending paths.
- [ ] A unit test proves the config-commit step bites: with the step removed, a worktree where the
  CLI left `openspec/config.yaml` untracked but the harness committed the change yields a dirty
  worktree at the test gate; with the step present, the worktree is clean.
- [ ] A unit test proves the dirty-block-paths change bites: with the change removed, the dirty
  block reason omits the path; with it present, the reason includes the porcelain path(s).
- [ ] `npm run ci` passes end-to-end (core tests, `build.mjs --check` mirror in sync,
  install-smoke, `openspec validate --all`).
