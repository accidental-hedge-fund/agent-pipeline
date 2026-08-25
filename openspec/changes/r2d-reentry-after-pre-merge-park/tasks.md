## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected test that drives a `pre-merge` re-entry with `getOnDiskForIssue` → null, a linked open PR whose head SHA matches the last-advanced candidate, and otherwise passing gates through ready-to-deploy. Assert the test **fails** against current code if trusted-surface records `worktree_unavailable` or the PR is not tagged `pipeline:ready-to-deploy`. No live network, git, or subprocess
- [x] 1.2 Add an injected test with no on-disk worktree and a PR head that differs from the last-advanced candidate pin. Assert the test **fails** against current code if that PR head is stored as trusted-surface or readiness `candidate_sha`, or if ready-to-deploy tags the PR
- [x] 1.3 Add an injected test with no on-disk worktree, no explicit override, and no linked open PR. Assert the decision is `blocked` with a named outcome and no invented SHA. Verify this test already describes fail-closed (it may pass today via `worktree_unavailable`; after the fix it MUST still fail closed under a named unresolved code, not passthrough)
- [x] 1.4 Add an injected test where a managed worktree HEAD is present and a different PR head exists. Assert trusted-surface `candidate_sha` is the worktree HEAD, not the PR head. Verify this still passes after the fallback lands

## 2. Shared candidate SHA resolver (class gate)

- [x] 2.1 In the trusted-surface decision path (`ensureTrustedSurfaceDecision` or the extracted resolver it calls), when `getOnDiskForIssue` is null, resolve `candidate_sha` from explicit override (full 40-hex) else linked open PR head that matches last-advanced pin (or pin absent). Confirm `gh --json` field names with a real call before coding. Verify task 1.1 now fails only on the tag/decision assertion that still needs finalize, not on `worktree_unavailable`
- [x] 2.2 When last-advanced pin P is present and PR head H ≠ P, persist `blocked` with a named mismatch code and do not set `candidate_sha` to H. Verify task 1.2 now passes. Do not add a new `BlockerKind`
- [x] 2.3 When no worktree, no override, and no PR head exist, persist `blocked` with a named unresolved code (not an invented SHA, not silent passthrough). Verify task 1.3 still fail-closes after the change
- [x] 2.4 When a managed worktree HEAD is a full 40-hex SHA, keep using that HEAD. Verify task 1.4 still passes
- [x] 2.5 After SHA resolve, compute or reuse a SHA-matched trusted-surface decision via an injectable object-source seam (changed paths / base blobs). Do not rematerialize a managed worktree. Do not invent `passthrough` when paths cannot be read. If compute and reuse both fail, `blocked` with a named reason. Verify a fixture that cannot read paths still blocks

## 3. Ready-to-deploy tag and readiness subject

- [x] 3.1 Keep `deploy_ready.finalize` as the single PR-tag path. After a non-blocked trusted-surface decision on the matching-PR-head fixture, the linked PR SHALL be tagged `pipeline:ready-to-deploy` and the log SHALL include `PR #<n> tagged pipeline:ready-to-deploy`. Verify task 1.1 now passes. Do not add a second tag helper
- [x] 3.2 When a readiness producer emits `evidence_subject` on that path, `candidate_sha` SHALL be the resolved PR head (or override) and `pr` SHALL be that PR number. Missing or mismatched SHA still fail-closes subject production. Verify with an injected assertion on the matching-head fixture and on the mismatch fixture
- [x] 3.3 Advance still never merges. Verify the matching-head fixture does not call merge. Do not add `auto_merge`
- [x] 3.4 Load the last successful pre-merge candidate from durable records (prior-run `stage_complete` and pre-merge delta-review SHA) into `lastAdvancedPin`. Verify mismatch rejection when that is the only prior pin
- [x] 3.5 Immediately before ready-to-deploy tagging, re-fetch the linked PR head and require it to equal the trusted-surface candidate. Refuse with named `stale_pr_head` on mismatch
- [x] 3.6 Wire `buildReadinessEvidenceSubjectFromDecision` to persist `evidence_subject` on the emitted bundle from the trusted-surface decision. Verify by reading the actual summary.json subject
- [x] 3.7 Select the newest durable last-advanced pin by run/event timestamp across trusted-surface and pre-merge records. Verify a multi-run re-entry whose older SHA matches the live PR head and whose newest pin differs is mismatch-blocked and does not tag ready-to-deploy
- [x] 3.8 Persist an immutable trusted-surface decision timestamp on every decision write and order last-advanced pins by that time, not originating run start. Verify a reused older run ID whose decision is updated after a later-started run is the newest pin; a PR head matching the later-started SHA is mismatch-blocked

## 4. Park-resume exception (late-stage only)

- [x] 4.1 Do not call `createWorktree` solely to satisfy trusted-surface / R2D SHA resolution on a `pre-merge` (or later) re-entry. Verify the matching-head fixture never creates a managed worktree. Early-stage resume (`createWorktree` when the stage needs a tree) SHALL remain unchanged; verify existing park-resume tests still pass
- [x] 4.2 Do not change park-release safety, dirty/local-only retain, or capacity counting. Verify existing parked-item release tests still pass

## 5. Gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 5.2 Run `openspec validate r2d-reentry-after-pre-merge-park` and `npm run ci` from the repo root. Verify both are green. Do not rematerialize worktrees at `pre-merge` only for this check. Do not merge inside advance/loop. Do not change park-release
