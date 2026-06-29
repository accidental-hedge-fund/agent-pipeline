# Tasks

## 1. Thread an optional staging scope through the salvage path

- [ ] 1.1 Add an optional `scope?: string` (git pathspec, e.g. `openspec/`) parameter to
  `salvageUncommittedWork` in `core/scripts/salvage-harness-work.ts`, defaulting to the existing
  unscoped behavior.
- [ ] 1.2 When `scope` is set, restrict the dirtiness check: pass the scope to the `gitStatus`
  seam so `git status --porcelain -- <scope>` is consulted; an in-scope-clean worktree returns
  `{ salvaged: false }` (no commit) even if files outside the scope are dirty.
- [ ] 1.3 When `scope` is set, restrict staging: the `gitAddAll` args SHALL include the scope
  pathspec so only in-scope changes are staged (keep `:(exclude)node_modules`); when `scope` is
  absent, keep `["add", "-A", "--", ":(exclude)node_modules"]` exactly as today.
- [ ] 1.4 Forward `scope` through `trySalvageUncommittedWork` (non-throwing wrapper) unchanged in
  semantics.

## 2. Scope the OpenSpec authoring salvage call site

- [ ] 2.1 In `core/scripts/stages/planning.ts`, give `salvageIfNoNewCommit` an optional `scope`
  parameter forwarded to `trySalvageUncommittedWork`.
- [ ] 2.2 At the OpenSpec authoring call site
  (`salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "OpenSpec authoring", osAuthorHeadBefore)`),
  pass the scope `openspec/`.
- [ ] 2.3 Leave the implement call site (`"implement"`) and all fix/test-fix salvage call sites
  scope-free (unchanged unscoped behavior).

## 3. Tests (must bite)

- [ ] 3.1 Unit: scoped salvage with a worktree dirty under both `openspec/changes/x/proposal.md`
  and `tasks/todo.md` → `gitAddAll` args restrict to `openspec/`; commit contains no out-of-scope
  path. Assert it fails without the scope (existing `git add -A` would include `tasks/todo.md`).
- [ ] 3.2 Unit: scoped salvage with a worktree dirty only under `tasks/todo.md` (in-scope clean) →
  `{ salvaged: false }`, no `gitAddAll`/`gitCommit` call.
- [ ] 3.3 Contract: a scoped authoring salvage commit (only `openspec/` files) passes
  `verifyHarnessCommits` with `allowPattern: /^openspec\//` (mirror the existing
  `salvage-harness-work.test.ts:154` test, now produced by the scoped path).
- [ ] 3.4 Regression: confirm the unscoped implement-stage salvage still stages a non-`openspec/`
  file (existing tests stay green; add a focused assertion if not already covered).

## 4. Mirror + gate

- [ ] 4.1 Regenerate the mirror: `node scripts/build.mjs`; commit the `plugin/` changes in the same
  change.
- [ ] 4.2 Run `npm run ci` from the repo root; treat red as not-done.
