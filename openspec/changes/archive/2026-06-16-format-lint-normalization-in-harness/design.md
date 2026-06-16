## Context

The implementing and fix-round stages invoke a harness that produces code. Currently the pipeline opens or updates a PR immediately after the harness exits (subject to test-gate and commit-verification). Formatter and linter violations are only caught when CI runs `cargo fmt --check`, `cargo clippy -D warnings`, or `eslint` — after the PR is already open. This has caused repeated manual take-overs across pipeline-desk runs (#42, #43, #21). The fix is to insert a normalization step between harness exit and PR open/update.

## Goals / Non-Goals

**Goals:**
- Run operator-configured formatter/linter commands in the worktree after the implementing and fix-round harnesses exit.
- Auto-apply mutations (e.g. `cargo fmt`, `eslint --fix`) and commit the result with a `chore: auto-format` commit so the fix is traceable.
- Block with the command output as the reason if a command exits non-zero after auto-fix (i.e. a violation the tool cannot fix itself).
- Opt-in only: zero behavior change when `format_gate` is absent from config.

**Non-Goals:**
- Running the format gate on every pipeline stage (only post-harness stages: implementing and fix rounds).
- Auto-detecting which formatter/linter to run (the operator must declare them; auto-detection is out of scope).
- Making the format gate part of the test gate (they are separate concerns).

## Decisions

### Decision 1 — Config shape: flat command list with `auto_fix` flag

Each `format_gate` entry is `{ command: string, auto_fix: boolean }`. `auto_fix: true` means the command both detects AND fixes; the pipeline runs it, checks for a dirty worktree, commits any changes, then re-runs it to verify. `auto_fix: false` means the command is check-only; a non-zero exit immediately blocks.

**Alternative considered:** separate `fix_command` / `check_command` pairs. Rejected — most tools use flags (`--fix`, `--write`) to switch modes; a single `command` with `auto_fix: true` captures this more directly without doubling the config surface.

### Decision 2 — Auto-fix commit message

Auto-format commits use the message `chore: auto-format (#<issue_number>)`. This is a `chore:` prefix so `isPipelineInternalCommit` can classify it as pipeline-internal and the review-SHA gate does not re-trigger a full review on a pure formatting commit.

**Alternative considered:** amending the preceding harness commit. Rejected — amending is non-deterministic with salvage commits and makes the format step invisible in the log.

### Decision 3 — Placement: after harness exit, before test gate

The format gate runs AFTER the harness exits (and after the existing salvage/verify pass) but BEFORE the test gate. This order means: (a) the test gate sees already-formatted code (no spurious test failures due to fmt/clippy in the same run), and (b) the format commit is included in the commit range that the test gate validates.

**Alternative considered:** after test gate. Rejected — the test gate can catch formatter violations in repos where `npm run ci` includes `cargo fmt --check`; but many repos don't, and we want formatting normalized before the PR is opened regardless.

### Decision 4 — Where the logic lives

A new `runFormatGate(worktreePath, config, issueNumber, deps)` function in `core/scripts/stages/format-gate.ts` (mirroring the test-gate pattern). The implementing stage (`implementing.ts`) and fix stages (`fix.ts`) call it after their existing harness-exit verification and before pushing/opening the PR.

### Decision 5 — `isPipelineInternalCommit` extension

The existing `isPipelineInternalCommit` predicate in `review-sha-gating.ts` (or wherever it lives) SHALL be extended to recognize `chore: auto-format (#` as a pipeline-internal prefix, so the review-SHA gate does not re-trigger on auto-format commits.

## Risks / Trade-offs

- [Risk: Auto-fix commits inflate the review diff] → The reviewer will see formatting changes alongside logic changes. Mitigation: the `chore: auto-format` commit prefix makes formatting commits visually separable; the reviewer prompt already instructs reviewers to ignore formatting.
- [Risk: `auto_fix: true` + check re-run still exits non-zero in rare edge cases] → The pipeline blocks with the command output. Operators can use `--override` to bypass if the violation is a known false positive.
- [Risk: `isPipelineInternalCommit` expansion] → Over-broad matching could suppress legitimate re-reviews. The prefix `chore: auto-format (#` is specific enough; a test must cover the boundary.

## Open Questions

- Should `format_gate` entries be allowed to declare a `working_dir` relative to the worktree root (for monorepos)? Left for a follow-up issue; this change assumes worktree root.
