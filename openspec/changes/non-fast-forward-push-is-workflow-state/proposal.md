## Why

`single 1038` (2026-08-17, installed v1.39.1, loop `loop-73346e80c28e4e77-s1`) parked at `fix-1` with `blocker_kind: push-failed`. The loop classed the reject as `transient-rate-limit` and ran `wait_and_retry`. The push was not a rate limit. Local worktree HEAD was `8ea2d1a` (first “address review 1” commit). Remote PR #1102 was already at `bb208ba` (second fix commit from the successor loop). Git rejected the push as non-fast-forward. Waiting cannot make an older tip fast-forward.

This is a class defect, not a fix-stage mole. `isTransientPushError` already returns false for `non-fast-forward` / `rejected` / `fetch first`. The shared push wrapper still emits `reason_code: "transient-infra"` and `head_drift: false` for that stderr, including the fail-closed `siteId` path. Fix then maps `head_drift ? workflow-state : transient-infra`. Loop projection maps `transient-infra` to `transient-rate-limit` → `wait_and_retry`. The next identical stale-tip push at any `pushWithCurrencyCheck` caller will park the same way until the classifier and recipe change.

## What Changes

- Shared push-error classification SHALL treat stderr that contains `non-fast-forward`, `rejected`, or `fetch first` as `workflow-state` with `head_drift: true`. It SHALL NOT emit `transient-infra` for that class.
- Durable projection SHALL keep that diagnostic in `workflow-state`. It SHALL NOT project it to `transient-rate-limit`.
- Recovery SHALL rematerialize or fast-forward the managed worktree to the open-PR / remote head, then continue. It SHALL NOT run `wait_and_retry`.
- After a `fix-no-actionable-work` noop, if local HEAD is an ancestor of `origin/<branch>`, the stage SHALL skip the push and advance. It SHALL NOT push the older tip.
- No path SHALL force-push (`--force` or `--force-with-lease`) to reconcile a non-fast-forward.
- Inventory site `stages.fix:push-failed#0` MAY stay `transient-retryable` for HTTP 5xx after currency re-sync. That disposition SHALL NOT reclassify a non-fast-forward as transient.

**Class vs site (engine-dogfood bar):**

1. **Class:** stale local tip versus PR / remote head (non-fast-forward) is workflow-state. Recover by rematerialize or fast-forward to that remote head. Never wait. Never force-push.
2. **Shared law:** classifier in `pushWithCurrencyCheck` / `isTransientPushError`; diagnostic reason from the wrapper, not a site ternary; `resync_workflow_state` rematerializes or fast-forwards a present-but-stale tree; skip-push gate after noop when local is an ancestor.
3. **Next identical fault:** a later planning, fix, or other wrapper caller with the same stderr does not need a new mole. The wrapper and recipe already classify and recover.

## Acceptance criteria

- [ ] Fixture stderr from the #1038 park (`non-fast-forward` + behind-remote hint) classifies as `workflow-state` with `head_drift: true`. Without the fix the same fixture is `transient-infra` and the loop recipe is `wait_and_retry`.
- [ ] The same fixture never projects to durable class `transient-rate-limit`.
- [ ] Loop recovery for that diagnostic selects rematerialize / fast-forward to the PR or remote head, then continue. It does not select `wait_and_retry`.
- [ ] After a `fix-no-actionable-work` noop, when local HEAD is an ancestor of `origin/<branch>`, the stage skips the push and advances.
- [ ] No recovery or retry path issues `git push --force` or `--force-with-lease` for this class.
- [ ] A true HTTP 5xx / connection-reset push still classifies as `transient-infra` and may still retry under the existing `transient-retryable` wrapper.
- [ ] Fail-closed `siteId` path on the same wrapper still emits `workflow-state` / `head_drift: true` for the #1038 fixture (not blanket `transient-infra`).
- [ ] Unit tests inject deps. They do no real network, git, or subprocess. `openspec validate` passes. Implementation later lands with `npm run ci` green and regenerated `plugin/` if `core/` changes.

## Capabilities

### New Capabilities

- `push-failure-classification`: Shared git-push stderr classification and the skip-ancestor-push / never-force-push rules for stale local tips.

### Modified Capabilities

- `escalation-site-dispositions`: A `transient-retryable` push wrapper SHALL emit the classified failure reason. Non-fast-forward SHALL be `workflow-state`, not the site inventory’s default `transient-infra`.
- `autonomous-recovery-controller`: Workflow-state recovery for a stale-tip / non-fast-forward diagnostic SHALL rematerialize or fast-forward the managed worktree to the PR / remote head, then continue. It SHALL NOT `wait_and_retry`.
- `fix-round-noop-advance`: After a `fix-no-actionable-work` advance decision, skip the push when local HEAD is an ancestor of `origin/<branch>`.

## Impact

- **Classifier:** `core/scripts/transient-wrappers.ts` (`isTransientPushError`, `pushWithCurrencyCheck` success and fail-closed `siteId` paths).
- **Callers:** `core/scripts/stages/fix.ts` (use wrapper `reason_code`; skip ancestor push after noop). `core/scripts/stages/planning.ts` inherits the wrapper classification.
- **Recovery:** `core/scripts/pipeline.ts` `resync_workflow_state` / rematerialize-or-fast-forward of a present-but-stale managed worktree to the open-PR or verified remote tip. Default policy stays `resync_workflow_state` then `repair_pipeline_item` for `workflow-state`.
- **Inventory:** `stages.fix:push-failed#0` remains `transient-retryable` for true transient blips. Notes / tests must not treat every `push-failed` as `transient-infra`.
- **Tests:** `core/test/` regression with the #1038 stderr fixture; wrapper, diagnostic projection, loop recipe selection, and fix noop skip-push. Injected deps only.
- **Out of scope:** Review-1-as-human park on the same run (#1099, merged). Extra `issue-context-snapshot` / recovery files that landed in `bb208ba`. Force-push. The FRG chain (#1038 → #1039 → {#1040, #1041}). #579 pre-merge archive on a stale base (different site).
- **Depends on:** none. Independent of the FRG chain. Do not block #1038 on this.
- **Program:** v1.39.2. Dogfood: #1038 / PR #1102.
