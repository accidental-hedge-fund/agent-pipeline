## Why

`--init` is documented as idempotent — it should skip writing `.github/pipeline.yml` when the file already exists. In practice it overwrites the file when the existing copy is **untracked by git**, silently destroying hand-edited or app-generated content with no recovery path. Because re-running `--init` is presented as a safe, no-op setup convenience, users have no reason to expect data loss.

## What Changes

- `scaffoldDefaultConfig` SHALL add an explicit `fs.existsSync` guard **before** the `writeFileSync` call. The current implementation relies solely on the `wx` (exclusive-create) flag, which only protects against the file existing at the exact same resolved path. If `cfg.repo_dir` resolves to a git worktree path (where untracked files from the main checkout are absent), `wx` passes even though the user's file exists in the main tree — overwriting it when the worktree file is later committed or propagated.
- A regression test SHALL be added that specifically exercises the untracked-file scenario: write a file directly via `fs.writeFileSync` (simulating an untracked file present on disk), then assert `scaffoldDefaultConfig` returns `{ created: false }` and leaves the file unchanged.
- The existing `init-command` spec's no-clobber requirement is extended with an explicit untracked-file scenario so the contract is precisely testable.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `init-command`: Add untracked-file scenario to the no-clobber requirement; add regression test requirement for the untracked case.

## Impact

- `core/scripts/config.ts` — `scaffoldDefaultConfig` function: add `existsSync` guard
- `core/test/init.test.ts` — add regression test for untracked-file overwrite
- `openspec/specs/init-command/spec.md` — new scenario under existing no-clobber requirement

## Acceptance Criteria

- [ ] Running `pipeline --init` on a repo where `.github/pipeline.yml` exists (even as an untracked file) prints a "already exists — skipping scaffold" notice and exits 0 **without modifying the file**.
- [ ] Running `pipeline --init` on a repo with no `.github/pipeline.yml` still creates the file and prints a "created" message.
- [ ] The regression test (`scaffoldDefaultConfig: does not overwrite an existing untracked .github/pipeline.yml`) fails before the fix and passes after.
- [ ] `npm run ci` passes (all tests green, mirror in sync).
