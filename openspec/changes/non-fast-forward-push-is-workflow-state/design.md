## Context

See `proposal.md` for motivation.

Today three layers disagree on the same stderr:

1. `isTransientPushError` already returns **false** for `non-fast-forward` / `rejected` / `fetch first`.
2. `pushWithCurrencyCheck` still returns `reason_code: "transient-infra"` and `head_drift: false` for that non-transient reject, including the fail-closed `siteId` path.
3. `stages/fix.ts` then builds `reasonCode: pushResult.head_drift ? "workflow-state" : "transient-infra"`.

`projectPipelineReasonCode("transient-infra")` is `transient-rate-limit`. Default policy for that class is only `wait_and_retry`. Waiting cannot make `8ea2d1a` fast-forward onto `bb208ba`.

`resync_workflow_state` today only clears `pipeline:blocked` and re-enters. `ensureManagedWorktree` skips a present worktree, so a present-but-stale tree stays stale after label-clear. The #1038 successor loop continued only because rematerialize happened to recreate onto `bb208ba`.

Inventory `stages.fix:push-failed#0` is `transient-retryable` with canonical reason `transient-infra`. That is correct for HTTP 502 after currency re-sync. It is not a license to stamp every `push-failed` as transient.

Constraints:

- Class over site. Shared wrapper + shared recipe. Not a `fix.ts`-only mole.
- Never force-push.
- Existing rematerialize dirty / local-only refuse stays.
- Unit tests inject deps. No real network, git, or subprocess.
- Site `stages.fix:push-failed#0` may stay `transient-retryable`.

## Goals / Non-Goals

**Goals:**

- One shared push classifier: non-fast-forward class → `workflow-state` + `head_drift: true` on every wrapper path.
- Callers emit the wrapper `reason_code`. No site ternary that drops `head_drift`.
- Loop recipe rematerializes or fast-forwards the managed worktree to the PR / remote head, then continues. Never `wait_and_retry` for this class.
- After `fix-no-actionable-work`, skip push when local HEAD is an ancestor of `origin/<branch>`.
- HTTP 5xx on the same site still retries.

**Non-Goals:**

- Changing `DurableBlockerClass` or adding a new reason code.
- Changing default `transient-rate-limit` recipes.
- Force-push or `--force-with-lease`.
- Broadening rematerialize so every present worktree is recreated (the current “present ⇒ skipped” contract stays for absence-only callers).
- #1099 Review-1-as-human, #579 archive-on-stale-base, or the FRG chain.
- Host janitor scripts.

## Decisions

### D1 — Classify in the shared wrapper, not at the site

**Decision:** `pushWithCurrencyCheck` sets `reason_code: "workflow-state"` and `head_drift: true` whenever `isTransientPushError` is false because the stderr contains `non-fast-forward`, `rejected`, or `fetch first`. The fail-closed `siteId` path uses the same classification. Fix (and any other caller) emits `pushResult.reason_code` instead of the `head_drift` ternary.

**Rationale:** The helper already knows the class and then throws it away. Planning already uses the same wrapper. A `fix.ts`-only remap would leave the next caller to re-park.

**Alternatives considered:**

- Only change `fix.ts` ternary → rejected. Site mole. Planning and the fail-closed path stay wrong.
- New reason code `stale-tip` → rejected. `workflow-state` already projects to rematerialize / resync. Do not grow the closed vocabulary for one stderr shape.
- Flip inventory site to `deliberately-fail-closed` → rejected. HTTP 502 after currency re-sync is still a real transient.

### D2 — Teach `resync_workflow_state` currency for this evidence

**Decision:** When the claimed diagnostic is `workflow-state` + `push-failed` (or equivalent stale-tip / non-fast-forward evidence), `resync_workflow_state` SHALL fetch the open-PR or verified remote tip and:

1. Fast-forward the present managed worktree when local HEAD is an ancestor of that tip.
2. Otherwise rematerialize onto that tip when rematerialize safety allows (no dirty / local-only unpushed product destroy).
3. Then clear the mechanical blocked label (existing `resyncMechanicalBlock` postcondition) and return success.

Other `workflow-state` diagnostics keep today’s label-clear + re-enter behavior.

**Rationale:** Label-clear alone leaves a present-but-stale tree. `ensureManagedWorktree` skips present trees. The class recipe must move HEAD. Scoping the extra action to stale-tip / non-fast-forward evidence avoids recreating every workflow-state park.

**Alternatives considered:**

- New recipe token `rematerialize_to_remote_head` → rejected for now. Adds policy-migration surface. `resync_workflow_state` is already the first `workflow-state` recipe.
- Always rematerialize on every `resync_workflow_state` → rejected. Too broad. Merge-conflict and label-only parks do not need a tree rebuild.
- In-stage rematerialize inside the push wrapper before returning failure → rejected as a hidden retry. The loop recipe is the recoverer. The skip-push gate (D3) is the in-stage prevention.

### D3 — Skip ancestor push after noop

**Decision:** After a `fix-no-actionable-work` decision, compare local HEAD to `origin/<branch>` (after fetch, injected git seam). If local is an ancestor, skip `pushWithCurrencyCheck` and advance. If not an ancestor, keep the existing wrapper push.

**Rationale:** #349 already decided there is nothing to deliver. Pushing `8ea2d1a` cannot update `bb208ba`. The park is a self-inflicted stale-tip push.

**Alternatives considered:**

- Always rematerialize then push after noop → rejected. There is nothing local to publish. Skip is smaller and never races the remote tip.
- Push and let recovery rematerialize → rejected. That is the #1038 park.

### D4 — Fixture-first regression

**Decision:** One exported fixture string matching the #1038 git reject (`! [rejected] … (non-fast-forward)` plus the behind-remote / `fetch first` hint). Tests assert, without the classifier fix:

- wrapper `reason_code === "transient-infra"` and loop recipe `wait_and_retry`

and with the fix:

- wrapper `reason_code === "workflow-state"`, `head_drift === true`, durable class `workflow-state`, first recipe rematerialize / `resync_workflow_state`, not `wait_and_retry`.

A second test covers fail-closed `siteId`. A third covers HTTP 502 still retrying. A fourth covers ancestor skip-push after noop.

**Rationale:** The issue names this fixture as the bite test.

## Risks / Trade-offs

- **[Risk] Broad `rejected` token** → Mitigation: keep the existing `isTransientPushError` token set. Require `non-fast-forward` / `fetch first` / `rejected` as today. Do not add host-specific phrasing.
- **[Risk] Fast-forward or rematerialize drops unique local commits** → Mitigation: reuse rematerialize dirty / local-only refuse. Fast-forward only when local is an ancestor. Unique unpushed product work fails typed, never force-push.
- **[Risk] `resync_workflow_state` grows a second job** → Mitigation: D2 scopes the currency action to stale-tip / non-fast-forward evidence. Other workflow-state parks stay label-clear.
- **[Risk] Inventory `canonical_reason: transient-infra` misleads metrics** → Mitigation: tests and notes treat inventory reason as the *default transient* class, not the only legal emission. Classifier wins.

## Migration Plan

- Ship in v1.39.2 with the usual `core/` + regenerated `plugin/` commit.
- No contract hash rewrite. Default `workflow-state` recipe list is unchanged (`resync_workflow_state`, `repair_pipeline_item`).
- No operator config change.
- Rollback is revert. Worst case returns to the #1038 wait-and-retry park.

## Open Questions

None. The issue names the class, the tokens, the recipe, the skip-push gate, and the fixture.
