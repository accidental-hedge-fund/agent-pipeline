## Why

Salvage already excludes `node_modules` at any nesting depth (#521). The post-harness
commit scan in `verifyHarnessCommits` still treats only a **leading** path component of
`node_modules` as forbidden (`file.split("/")[0] === "node_modules"`). Commits that add
nested monorepo install paths such as `apps/web/node_modules/...` therefore **pass**
verify and fail later in CI — the same monorepo class salvage already fixed, but on the
verify side of the belt-and-suspenders pair.

## What Changes

- **Depth-agnostic `node_modules` detection in the post-commit verify scan**
  (`core/scripts/verify-harness-commits.ts`). Reject any added tree path that contains a
  `node_modules` path segment at any depth (equivalent to matching
  `/(^|\/)node_modules(\/|$)/`), not only paths whose first component is `node_modules`.
- **Regression coverage** for a nested monorepo path (e.g. `apps/web/node_modules/...`)
  that fails without the segment-aware check and passes root-level cases already covered
  by #180.
- Existing root-level and `node_modules/foo` blocking behavior, delete-only remediation
  commits, empty-range no-op, and "surface node_modules diagnostic before other checks"
  behavior remain unchanged.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `worktree-staging-exclusions`: the post-commit scan requirement currently blocks only
  paths whose **leading** path component is `node_modules`; it SHALL block any path that
  contains a `node_modules` path segment at any nesting depth, matching salvage parity.

## Acceptance Criteria

- [ ] A harness commit that adds a nested monorepo path such as
      `apps/web/node_modules/.pnpm/...` (or any path with a `node_modules` segment not at
      the worktree root) causes `verifyHarnessCommits` to return `ok: false` with a
      diagnostic that names the commit SHA and the offending path and states that
      `node_modules` must not be committed.
- [ ] A harness commit that adds a worktree-root `node_modules` entry (or
      `node_modules/foo`) continues to be blocked with the same class of diagnostic
      (no regression of #180 root-level behavior).
- [ ] A harness commit whose added paths do not contain a `node_modules` path segment
      still passes the node_modules scan.
- [ ] A remediation commit that only deletes a previously committed `node_modules` entry
      still passes the scan (delete-only paths are not treated as additions).
- [ ] A regression test uses a nested monorepo path and bites: under the legacy
      root-only check (`file.split("/")[0] === "node_modules"`), the nested path would
      pass; with the segment-aware check it fails verify.
- [ ] Salvage pathspec composition is unchanged beyond documented parity (no salvage
      behavior rewrite in this change).
- [ ] `npm run ci` passes (core tests, `plugin/` mirror sync if `core/` changes, install
      smoke, `openspec validate --all`).

## Impact

- `core/scripts/verify-harness-commits.ts`: replace the root-only leading-segment check
  with a path-segment check for `node_modules` at any depth.
- `core/test/verify-harness-commits.test.ts` (and any stage/fix callers that assert the
  scan): add a nested monorepo regression case; keep existing #180 cases green.
- After `core/` edits: regenerate `plugin/` via `node scripts/build.mjs` in the same
  change.
- No config keys, CLI surface, state-machine edges, review/SHA-gate contracts, or salvage
  pathspec composition changes. The salvage depth-agnostic exclusion from #521 stays as
  the prevention half; this change closes the detection half for nested paths.
