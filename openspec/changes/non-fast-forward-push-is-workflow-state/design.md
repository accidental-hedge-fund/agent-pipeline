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

**Decision:** Export one case-insensitive `classifyPushFailure(stderr)` and call it **before** retry eligibility on every `pushWithCurrencyCheck` path, including fail-closed `siteId`. Tokens `non-fast-forward`, `rejected`, or `fetch first` → `reason_code: "workflow-state"`, `head_drift: true`, not retryable. HTTP 5xx / connection-reset without those tokens stay `transient-infra` and may retry. Production callers today are `stages/fix.ts` and `stages/planning.ts`. Both SHALL emit `pushResult.reason_code` on `push-failed`. Fix SHALL delete `head_drift ? "workflow-state" : "transient-infra"`. Planning SHALL stop omitting the diagnostic.

**Rationale:** The helper already knows the class and then throws it away. A `fix.ts`-only remap would leave planning (and any later caller) to re-park. Classification must win over inventory default `transient-infra`.

**Alternatives considered:**

- Only change `fix.ts` ternary → rejected. Site mole. Planning and the fail-closed path stay wrong.
- New reason code `stale-tip` → rejected. `workflow-state` already projects to rematerialize / resync. Do not grow the closed vocabulary for one stderr shape.
- Flip inventory site to `deliberately-fail-closed` → rejected. HTTP 502 after currency re-sync is still a real transient.

### D2 — Teach `resync_workflow_state` currency for this evidence

**Decision:** When the claimed diagnostic is `workflow-state` + `push-failed` (or equivalent stale-tip / non-fast-forward evidence), `resync_workflow_state` SHALL resolve a verified target SHA, then move a present-but-stale managed worktree to that SHA when safety allows:

1. **Resolve target.** Prefer the open-PR head SHA (same order as `ensureManagedWorktree`: `prSha ?? remoteTip`). If no open PR exists, `git fetch origin <branch>` and verify `origin/<branch>` (or `FETCH_HEAD` from that fetch). If neither SHA can be verified, refuse typed (`unverified-remote-head`). Do not skip. Do not reset. Do not rematerialize.
2. **Safety before mutate.** Only fast-forward or `reset --hard` a managed worktree that is clean and non-unique: porcelain empty, and `merge-base --is-ancestor HEAD <verified-head>` is true (equality included). Dirty product or local-only unique commits (not an ancestor) refuse typed. Never force-push.
3. **Mutate.** Fast-forward (`merge --ff-only <verified-head>`) or hard-reset to the verified SHA. If the tree is absent, rematerialize via `ensureManagedWorktree` onto that same intended tip.
4. **Then** clear the mechanical blocked label (existing `resyncMechanicalBlock` postcondition) and return success.

Other `workflow-state` diagnostics keep today’s label-clear + re-enter behavior.

**Rationale:** Label-clear alone leaves a present-but-stale tree. `ensureManagedWorktree` skips present trees. The class recipe must move HEAD. Scoping the extra action to stale-tip / non-fast-forward evidence avoids recreating every workflow-state park.

**Alternatives considered:**

- New recipe token `rematerialize_to_remote_head` → rejected for now. Adds policy-migration surface. `resync_workflow_state` is already the first `workflow-state` recipe.
- Always rematerialize on every `resync_workflow_state` → rejected. Too broad. Merge-conflict and label-only parks do not need a tree rebuild.
- In-stage rematerialize inside the push wrapper before returning failure → rejected as a hidden retry. The loop recipe is the recoverer. The skip-push gate (D3) is the in-stage prevention.

### D3 — Skip ancestor push after noop

**Decision:** After a `fix-no-actionable-work` decision (empty effective blocking set, valid does-not-reproduce coverage, or #349 external-commit HEAD already past the reviewed SHA), resolve a verified target first, then test ancestry:

1. Verify target: open-PR head if present, else fetch and use `FETCH_HEAD` / `origin/<branch>` (same fail-closed pattern as `isCommitOnRemote` in `fix.ts`).
2. If verification fails, do **not** skip the push and do **not** reset. Fall through to `pushWithCurrencyCheck`.
3. If verification succeeds, run `git merge-base --is-ancestor HEAD <verified-head>`.
   - Exit 0 (remote ahead **or** equal): skip `pushWithCurrencyCheck` and advance.
   - Exit 1 (local ahead or diverged): keep the existing wrapper push; unique local commits stay.

**Rationale:** #349 already decided there is nothing to deliver. Pushing `8ea2d1a` cannot update `bb208ba`. The park is a self-inflicted stale-tip push. Equality is already on the remote, so a no-op push is also wasted. A failed fetch must not pretend the older tip is current.

**Alternatives considered:**

- Always rematerialize then push after noop → rejected. There is nothing local to publish. Skip is smaller and never races the remote tip.
- Push and let recovery rematerialize → rejected. That is the #1038 park.
- Silent skip when fetch/PR lookup fails → rejected. That would advance on an unverified tip.

### D5 — Typed refuse when currency would destroy unique work

**Decision:** When D2 would destroy dirty product or local-only unique commits, `resync_workflow_state` returns `{ succeeded: false }` with typed evidence (`dirty-worktree` or `local-only-unpushed`). It does not clear `pipeline:blocked`. It does not force-push. Class stays `workflow-state`. Default policy’s next recipe is `repair_pipeline_item`. It SHALL NOT become `wait_and_retry` or `transient-rate-limit`. Unverifiable local-only (`null` / `"unverifiable"`) also refuses, same as `#622` reclaim.

**Rationale:** Waiting cannot preserve unique work. Force-push would overwrite the PR. `repair_pipeline_item` is the existing second `workflow-state` recipe.

**Alternatives considered:**

- Remap refuse to `transient-infra` → rejected. That is the #1038 class bug.
- New durable class → rejected. `workflow-state` already owns this park.

### D4 — Fixture-first regression plus one end-to-end chain

**Decision:** One exported fixture string matching the complete #1038 park stderr (`! [rejected] … (non-fast-forward)` plus the behind-remote / `fetch first` hint). Export one case-insensitive classifier (`classifyPushFailure`) and call it **before** retry eligibility on every wrapper path, including fail-closed `siteId`.

One end-to-end unit test (injected deps only) proves the chain:

`#1038 fixture` → wrapper `{ reason_code: "workflow-state", head_drift: true }` → fix `push-failed` diagnostic uses that reason → `projectPipelineReasonCode` is `workflow-state` (not `transient-rate-limit`) → `DEFAULT_RECOVERY_POLICY["workflow-state"].recipes[0] === "resync_workflow_state"` and the list does not contain `wait_and_retry`.

Companion assertions document the pre-fix mapping that parked #1038: wrapper `reason_code: "transient-infra"` + `head_drift: false` plus the `head_drift ? workflow-state : transient-infra` ternary plus `projectPipelineReasonCode("transient-infra")` yields `transient-rate-limit` / `wait_and_retry`.

Also required: fail-closed `siteId` on the same fixture; HTTP 502 / connection-reset still retries; noop ancestry (remote-ahead and equal skip; local-ahead / diverged uses the wrapper and keeps unique commits); recovery command construction never includes `--force` or `--force-with-lease`.

**Rationale:** Isolated helper tests would not have caught the fix.ts remap. The issue names this fixture as the bite test.

## Risks / Trade-offs

- **[Risk] Broad `rejected` token** → Mitigation: one exported case-insensitive classifier runs **before** retry eligibility. Token set stays `non-fast-forward` / `fetch first` / `rejected`. Tests use the complete #1038 stderr, not a single token. HTTP 502 without those tokens stays transient. A hook reject that only says `rejected` becomes workflow-state (no wait), which is safer than treating it as a rate limit.
- **[Risk] Fast-forward or rematerialize drops unique local commits** → Mitigation: reuse rematerialize dirty / local-only refuse. Fast-forward / hard-reset only when the tree is clean and HEAD is an ancestor of the verified tip. Unique unpushed product work fails typed (`dirty-worktree` / `local-only-unpushed`), never force-push, never `wait_and_retry`.
- **[Risk] `resync_workflow_state` grows a second job** → Mitigation: D2 scopes the currency action to stale-tip / non-fast-forward evidence. Other workflow-state parks stay label-clear.
- **[Risk] Inventory `canonical_reason: transient-infra` misleads metrics** → Mitigation: tests and notes treat inventory reason as the *default transient* class, not the only legal emission. Classifier wins.
- **[Risk] Planning omits a diagnostic** → Mitigation: audit every `pushWithCurrencyCheck` caller. `planning.ts` must emit `pushResult.reason_code`. Do not rely on `mechanicalReasonCodeForKind("push-failed")` alone.

## Migration Plan

- Ship in v1.39.2 with the usual `core/` + regenerated `plugin/` commit.
- No contract hash rewrite. Default `workflow-state` recipe list is unchanged (`resync_workflow_state`, `repair_pipeline_item`).
- No operator config change.
- Rollback is revert. Worst case returns to the #1038 wait-and-retry park.

## Open Questions

None. The issue names the class, the tokens, the recipe, the skip-push gate, and the fixture.
