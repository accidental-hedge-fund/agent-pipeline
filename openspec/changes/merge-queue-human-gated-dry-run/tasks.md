## 1. CLI surface and registry

- [x] 1.1 Add `merge-queue` to `COMMAND_REGISTRY` with dry-run-safe metadata (`needsIssueNumber: false`, `mutatesGitHub: false`, allowlist including milestone/dryRun/repoPath/base/profile)
- [x] 1.2 Wire Commander options for `--milestone` and `--dry-run` (and fail-closed handling for premature apply/drive if the flag is recognized)
- [x] 1.3 Dispatch `pipeline merge-queue` from the CLI to the new handler; missing `--milestone` exits non-zero with usage
- [x] 1.4 Update registry/CLI allowlist cross-check tests so the new keyword and flags are covered

## 2. Selection and dry-run planner

- [x] 2.1 Create `MergeQueueDeps` (or equivalent) injection seam for milestone issue list, labels/R2D filter, `getPrForIssue`, PR view (mergeable/mergeStateStatus/headRefOid/base), and required checks
- [x] 2.2 Implement pure plan function: filter R2D → resolve PR → inspect mergeability/checks → build candidates vs skips with stable reason codes
- [x] 2.3 Order merge candidates by ascending issue number
- [x] 2.4 Align required-check pass/fail definition with `pipeline merge` (including no-required-checks fallback if merge already defines one)
- [x] 2.5 Implement dry-run stdout formatter (candidate fields, skips, footer “no merges performed”); empty candidate list exits 0
- [x] 2.6 Ensure dry-run path never calls `mergePr` / `gh pr merge` or label writers

## 3. Unit tests

- [x] 3.1 R2D-only: non-R2D milestone issues are not merge candidates
- [x] 3.2 Missing PR: resolver null excludes candidate; skip reason `missing-pr`
- [x] 3.3 Non-mergeable / UNKNOWN: excluded with `non-mergeable` (or documented equivalent)
- [x] 3.4 Checks not green: excluded with `checks-not-green`
- [x] 3.5 Happy path: clean MERGEABLE R2D PR is a candidate with would-merge action; order by issue number
- [x] 3.6 Dry-run never invokes merge/write deps; idempotent plan on same fixtures
- [x] 3.7 Advance/loop isolation: stage handlers and advance loop do not import merge-queue symbols
- [x] 3.8 All tests use injected deps only (no real network, git, or subprocess)

## 4. Host packaging and docs

- [x] 4.1 Add `merge-queue` to the namespaced single-source operation list so Claude/Codex gain `pipeline:merge-queue`
- [x] 4.2 Host command one-liner: dry-run queue plan for R2D PRs; never called by advance; human owns merge authority
- [x] 4.3 Update skill command tables / README operator notes if they enumerate merge surfaces
- [x] 4.4 Run `node scripts/build.mjs` and commit regenerated `plugin/` with core/packaging changes

## 5. Verification

- [x] 5.1 `openspec validate merge-queue-human-gated-dry-run` passes
- [x] 5.2 `npm run ci` green from repo root
- [ ] 5.3 Manual sanity (optional dogfood): dry-run against a real milestone prints plan and performs no merges
