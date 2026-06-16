## Context

`scaffoldDefaultConfig` in `core/scripts/config.ts` currently relies on the `wx` (exclusive-create) flag of `fs.writeFileSync` to detect a pre-existing `.github/pipeline.yml`. This should atomically fail with `EEXIST` if the file is already present. However, the function is always given `cfg.repo_dir`, which is the path returned by `findGitRoot`. `findGitRoot` stops at the first ancestor containing a `.git` entry — which returns the **worktree** root (not the main checkout root) when executed from inside a git worktree, because a worktree `.git` is a file, and `fs.existsSync` returns true for both files and directories.

An untracked `.github/pipeline.yml` in the **main checkout** will not be present in a derived **worktree**, so the `wx` check passes in the worktree context and the file is "created" there (or in the main checkout if the worktree and main checkout share a physical `.github/` — an edge-case dependent on worktree layout). Either way, the command falsely reports success and the user's intent is violated.

## Goals / Non-Goals

**Goals:**
- Make the no-clobber check explicit and path-independent: if the file exists on disk at `configPath`, never overwrite it.
- Add a targeted regression test that would have caught this bug.

**Non-Goals:**
- Fixing `findGitRoot` to distinguish worktrees from main checkouts (that is a separate concern; scoping it here would expand blast radius).
- Preventing the file from being created in the worktree vs. main checkout (that layout ambiguity is a pre-existing concern; the no-clobber fix is the P0 here).

## Decisions

**Explicit `existsSync` guard before the write.**
Add `if (fs.existsSync(configPath)) return { created: false };` at the top of `scaffoldDefaultConfig`, before `mkdirSync` and the `writeFileSync`. The `wx` flag is kept as defense-in-depth against a race where the file is created between the check and the write, but the guard makes the skip behavior independent of `wx` internals.

The check must come before `mkdirSync` so that a pre-existing `.github/` directory (already present but with `pipeline.yml` inside) doesn't get its contents altered.

**Regression test: untracked-file scenario.**
The existing no-clobber test (`scaffoldDefaultConfig: does not overwrite an existing .github/pipeline.yml`) writes the file with `fs.writeFileSync` — the same mechanism the production code uses for tracking. The regression test must simulate the exact failure mode: write the file *outside* `scaffoldDefaultConfig`'s control (same as an untracked file) and confirm the function skips. The new test is structurally identical to the existing no-clobber test but is named and documented to pin the untracked-file regression.

## Risks / Trade-offs

- **TOCTOU race**: the `existsSync` + `writeFileSync` sequence has a tiny race window. The retained `wx` flag on `writeFileSync` closes that window — if a concurrent process creates the file between check and write, `EEXIST` is still caught.
- **No behavior change for the happy path** (file absent): `existsSync` returns false, execution falls through to `mkdirSync` + `writeFileSync` exactly as before.
