## Why

An issue parked at `pre-merge` has its managed worktree released (clean + remote tip). Re-entry skips the stages that create a worktree and lands at `pre-merge`. The ready-to-deploy trusted-surface check then fails `worktree_unavailable` because it requires `getOnDiskForIssue` to resolve a live worktree. Observed on #1236 / PR #1242 (2026-08-25): pre-merge passed, visual/eval skipped, R2D refused, the issue was labeled `pipeline:ready-to-deploy`, the PR was not tagged, and the evidence bundle stayed at the earlier blocked run.

This is engine gate law, not a #1236 product mole. Any later-stage re-entry after park-release hits the same shared check.

## What Changes

- **Class law, not a path-local mole.** Trusted-surface candidate SHA resolution SHALL NOT require a live managed worktree when the run is at or after `pre-merge` and an authoritative candidate SHA is already available (linked open PR head that matches the last-advanced candidate, or an explicit candidate-SHA override).
- On that path, ready-to-deploy SHALL tag the linked PR `pipeline:ready-to-deploy` and SHALL emit a readiness subject bound to that SHA. The evidence bundle SHALL record the green terminal state.
- Fail-closed stays: no worktree, no matching open PR head, and no valid override → named blocked outcome. A PR head that does not match the last-advanced candidate SHALL NOT become the readiness subject.
- Late-stage re-entry SHALL NOT rematerialize a worktree only to satisfy this check. Early-stage resume still uses `createWorktree`. Park-release itself does not change.
- Regression tests SHALL bite on the #1236 shape (absent worktree + matching PR head reaches R2D tag) and on a mismatched PR head (must not be accepted).

**BREAKING:** none. Advance still never merges. Worktree-present runs keep using worktree HEAD.

Non-goals: merging inside advance/loop; recreating worktrees at `pre-merge` only to satisfy trusted-surface; changing park-release; launcher Node bootstrap (#1236); OMP host (#1235); factory-plane identity (#1237).

## Acceptance criteria

- [ ] Re-entering an issue at or after `pre-merge` with no managed worktree on disk, a linked open PR whose head SHA matches the last-advanced candidate, and otherwise passing gates, produces a trusted-surface decision whose `candidate_sha` is that PR head (not `worktree_unavailable`).
- [ ] That same run tags the linked PR `pipeline:ready-to-deploy` (same observable as the single-run path: `PR #N tagged pipeline:ready-to-deploy`) and emits a readiness subject bound to that SHA.
- [ ] The same re-entry with no worktree and no open PR, or with a PR head that is not the last-advanced candidate, still fails closed with a named outcome and does not tag the PR or invent a candidate SHA.
- [ ] An explicit candidate-SHA override (injectable seam; CLI flag only if one already exists) is accepted as the readiness subject when it is a full 40-hex SHA and, if a PR exists, matches that PR head. A bogus override is refused with a named outcome.
- [ ] A unit test fails if a re-run at `pre-merge` with `getOnDiskForIssue` → null and a live matching PR head reaches the R2D transition and the PR is not tagged, or the run reports `worktree_unavailable`. A second unit test fails if a PR head that is not the last-advanced candidate is accepted as the readiness subject. Tests inject I/O; no live network, git, or subprocess.
- [ ] OpenSpec deltas cover the readiness subject under re-entry. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends trusted-surface candidate resolution and late-stage park resume, not a new family. -->

### Modified Capabilities

- `trusted-surface-rebind`: Candidate SHA resolution for a verification-relevant run SHALL use worktree HEAD when present; otherwise an explicit candidate-SHA override or a linked open PR head that matches the last-advanced candidate. Absence of a managed worktree at or after `pre-merge` SHALL NOT by itself produce `worktree_unavailable` when one of those SHA sources succeeds.
- `parked-item-worktree-release`: Late-stage re-entry (at or after `pre-merge`) SHALL NOT require rematerializing a managed worktree solely so trusted-surface / ready-to-deploy can resolve a candidate SHA. Early-stage resume still creates via `createWorktree`.
- `pipeline-state-machine`: Reaching `ready-to-deploy` after that re-entry SHALL still finalize by tagging the linked PR `pipeline:ready-to-deploy`. Absence of a managed worktree SHALL NOT skip that tag when the candidate SHA resolved.
- `evidence-subject`: Readiness subject `candidate_sha` on that path SHALL be the resolved PR head or override SHA, produced by engine runtime state, not harness prose. Fail-closed subject production remains when no matching SHA source exists.

## Impact

- **Shared gate:** `core/scripts/pipeline-run.ts` `ensureTrustedSurfaceDecision` currently fails `worktree_unavailable` when `getOnDiskForIssue` returns null, before any SHA is known. That is the class hole. The same check runs at every stage, including the R2D iteration that `deploy_ready.finalize` then refuses.
- **R2D finalize:** `core/scripts/stages/deploy_ready.ts` already refuses when the durable decision is blocked, so the PR tag never happens even if the issue label already moved to `pipeline:ready-to-deploy`.
- **Park resume:** living `parked-item-worktree-release` says re-advance SHALL create a worktree. That still holds for stages that need a tree. This change carves the late-stage SHA-resolution path so R2D does not rematerialize a tree only to satisfy the check.
- **Tests:** injectable advance / trusted-surface tests covering matching PR head, mismatched PR head, missing PR, and override SHA. No live network, git, or subprocess.
- **Does not:** merge inside advance/loop; change park-release safety; recreate worktrees at `pre-merge`; add `auto_merge`; reverse papercut backlog policy.
- **Evidence (live, 2026-08-25):** run `1236/2026-08-25T16-48-11-054Z`. Pre-merge advanced; visual/eval skipped; R2D refused `trusted_surface outcome=blocked (worktree_unavailable)`. `run_complete final_state=ready-to-deploy` with no PR tag. Issue #1236 labeled `pipeline:ready-to-deploy`; PR #1242 unlabeled, `mergeStateStatus: CLEAN`. Park log: `park-release: released managed worktree for #1236 (clean + remote tip ...)`.
- **Class vs site:** the site is #1236 / PR #1242 after park at `pre-merge`. The class is: trusted-surface / readiness subject candidate SHA must resolve without a live managed worktree when a later-stage re-entry already has an authoritative PR head (or override). The next parked-at-pre-merge issue uses the same resolver and does not need a new mole issue.
