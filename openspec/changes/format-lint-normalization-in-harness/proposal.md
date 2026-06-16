## Why

The implementing/fix harness produces code that compiles and passes review but is not formatter/linter-clean; the first signal is a failing pre-merge CI check (`cargo fmt --check`, `cargo clippy -D warnings`, `eslint`), which requires a manual take-over. A normalization step immediately after the harness would either auto-fix style violations or block with a clear reason before a PR is opened.

## What Changes

- **New configurable `format_gate` section** in `.github/pipeline.yml` that lets operators declare one or more formatter/linter commands per language (e.g. `cargo fmt`, `cargo clippy --fix`, `eslint --fix`).
- After the implementing stage and after each fix-round stage, the pipeline SHALL run every configured `format_gate` command (in order) inside the worktree before opening or updating the PR.
- Commands that support auto-fix (`--fix` / `--write` variants) are applied first; the resulting changes are committed with a `chore: auto-format` commit so the harness commit range stays traceable.
- If a format/lint command exits non-zero after auto-fix, the pipeline blocks with the command output as the reason (rather than silently opening a PR that will fail CI).
- When no `format_gate` is configured, behavior is unchanged (existing pipeline runs are unaffected).

## Capabilities

### New Capabilities

- `harness-format-lint-gate`: Post-harness normalization step that runs configured formatter/linter commands, commits auto-fixes, and blocks on unfixable violations before the PR is opened or updated.

### Modified Capabilities

- `harness-step-verification`: The verification sequence after the implementation and fix-round harnesses now includes an optional format/lint gate between harness exit and PR open/update.
- `pipeline-configuration`: A new optional `format_gate` top-level key is added to `.github/pipeline.yml` schema.

## Impact

- `core/scripts/stages/fix.ts` and `core/scripts/stages/implementing.ts` — new gate invocation after harness exits.
- `core/scripts/config.ts` — new `format_gate` config shape (array of `{ command, auto_fix }` entries).
- `core/scripts/gh.ts` / worktree utilities — commit the auto-format diff when changes are produced.
- `.github/pipeline.yml` (this repo) — add `format_gate` entries for `cargo fmt` / `cargo clippy --fix` (or language-appropriate equivalent) so the pipeline self-tests the feature.
- `README.md` — document the `format_gate` option.
- No changes to `plugin/` by hand; regenerated via `node scripts/build.mjs` after core edits.
