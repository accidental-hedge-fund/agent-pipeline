## Context

See `proposal.md` for motivation and the lyric-utils `#268` cascade.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | A pre-PR park that already holds a pipeline-authored salvage or ownership-checkpoint commit is unpublished. Recovery paths key on an open PR, and the same-process timeout path parks because legacy `salvaged` is false when ownership checkpoint already authored the commit. |
| Site | Implementing timeout on lyric-utils `#268`, engine `v1.39.13`, salvage commit `00d1d81`, then `recover-parked` `no linked open PR; keep park`. Independently reproduced: plan-review auth failure before any PR. |
| Shared law | Classifier + recipe `publish_unpublished_stage_commit` + recover-parked deterministic-first (PR lookup after publish) + never-pushed local-only park-release. |
| Next identical fault | Timeout or harness failure at implement, fix, or another pre-PR product-mutating stage that leaves a salvage/checkpoint commit and no PR. That path MUST use this contract. An implementing-only `afterRound` skip is a mole. |

**Current constraints:**

- `#1246` / `harness-mutation-ownership` already checkpoints owned leftovers on timeout, including after HEAD movement. That is why `#268` had a clean salvage commit. Checkpoint is not the gap.
- `harness-round` skips unscoped salvage when `ownershipCheckpointed` is true, so implementing `afterRound` sees `salvaged === false` and takes the timeout-block path (`setBlocked` / `timed out after <N>s`) even though a salvage-equivalent commit exists.
- `resumeFromImplementing` already implements gates → push → create-or-find PR → `implementing → review-1`. Re-entry at `implementing` with commits ahead would use it — if the item were not `blocked` and if `recover-parked` did not fail-closed first.
- `recover-parked` resolves a linked open PR **before** deterministic recover. No PR → `fail-closed` / `no linked open PR; keep park`. That is correct for residual-review senior reflow (needs live HEAD) and wrong for pre-PR parks.
- `checkLocalOnlyCommits`: successful empty `ls-remote` plus unreachable-from-base is classified `unverifiable` (squash-merge). A never-pushed branch produces the same observation. Park-release retains (good) but with `--force if work was squash-merged` wording. `--force` would delete unpublished salvage.

## Goals / Non-Goals

**Goals:**

- One classifier and one recipe so the next unpublished timeout does not need a new mole.
- Same-process timeout with a matching commit publishes in-process.
- `recover-parked` retries publication when the first attempt fails or the process died after checkpoint.
- Never-pushed unpublished commits are hard-retained as local-only.
- Gates, no force-push, engine-owned `review-1` transition.

**Non-Goals:**

- Changing `implementation_timeout` or treating overrun as success without gates.
- `pipeline triage --force` / mid-flight operator label writes (`#1272` suggested fix 3 — rejected; engine-owned `transition()` is the path).
- `#1265` blocker theming (`workflow-engine-defect` vs `harness-timeout`).
- Train sibling-abandonment (`#1273`, already a separate change).
- LLM-first recovery or `repair_pipeline_item` as the first unpublished-commit action.
- Auto-merge, review override, or a merge stage.
- Publishing incomplete implement work (deliverable unsatisfied → completeness / re-invoke, not `review-1`).
- Weakening residual-review `recover-parked` rules (HIGH/CRITICAL/security/authority still non-overridable; senior path still needs PR HEAD).

## Decisions

### D1: Shared classifier and recipe, not an implementing-only afterRound branch

**Decision:** Put the publishable-unpublished predicate and the `publish_unpublished_stage_commit` action in a shared module consumed by implementing `afterRound`, `realExecuteRecovery`, and `recover-parked` deterministic-first. A drift-guard test fails if a new timeout-park site `setBlocked`s on harness timeout while the classifier matches and the site did not consult it.

**Rationale:** `#1246` already showed a path-local mole (format-gate) is incomplete. The `#268` site is implementing timeout; the class is any pre-PR unpublished pipeline-authored commit.

**Alternatives:** Implementing `afterRound` only (rejected: mole). Always re-enter implementing-resume and hope the blocked label is gone (rejected: `recover-parked` fail-closes first).

### D2: Reuse the existing post-implement sequence

**Decision:** The recipe executor calls the existing post-implementation helper (gates → currency-checked non-force push → create-or-find PR with closing reference → engine-owned `transition(implementing, review-1)`). Do not add a second push/PR implementation.

**Rationale:** `implementing-resume` already specifies this sequence. Duplicate publish logic would drift on docs-freshness, lockfile fold, and superseded-PR disposal.

**Alternatives:** Push+PR only, leave stage at `implementing` (rejected: operator still has to move the label). Skip gates because the work "looked complete" (rejected: salvage spec forbids bypassing the test gate; `#268` later passing tests does not license skipping them).

### D3: Checkpoint counts as salvage for the timeout fall-through

**Decision:** Same-process `afterRound` proceeds to post-implement when **either** legacy `salvaged` **or** `ownershipCheckpointed` is true, the tree is clean of unknown dirt, and the deliverable is satisfied. Do not set `salvaged = true` inside harness-round as a lie about which helper authored the commit; afterRound (or a shared "recovered work?" helper) consults both flags plus the classifier.

**Rationale:** Harness-round correctly skips unscoped salvage after scoped checkpoint (`#1246` mixed-dirt rule). The bug is the consumer treating "legacy salvage skipped" as "no recovered commit."

**Alternatives:** Make checkpoint set `salvaged = true` (rejected: conflates two authorship paths and hides skip-unscoped-salvage). Always run legacy salvage after checkpoint (rejected: `#1246` forbids unscoped salvage after scoped checkpoint).

### D4: recover-parked PR lookup moves after deterministic recover

**Decision:** Run unlink, stale-blocked resume (when a PR exists), and `publish_unpublished_stage_commit` **before** fail-closed on missing PR. Residual-review senior reflow still requires a live PR HEAD. Pre-PR engine-defect parks without a publishable commit skip senior reflow and re-enter advance.

**Rationale:** The current "no PR" refuse is correct for review residuals and wrong for the timeout class and for plan-review auth parks. Moving the gate preserves senior-path fail-closed.

**Alternatives:** Always no-op when no PR (rejected: leaves `#268` unrecovered). Invent `triage --force` for operators (rejected: label divergence; decisions require engine-owned transition).

### D5: Never-pushed + no merged PR = local-only

**Decision:** Empty successful `ls-remote` + unreachable-from-base is local-only unless bound merge-result proof or a linked merged PR exists. Squash-merge `unverifiable` stays only when that publication-then-delete evidence is present.

**Rationale:** The two observations share empty `ls-remote`. The discriminator is whether the engine can prove the head was published. `--force` must not be the recovery story for unpublished salvage.

**Alternatives:** Change only the park-release log string (rejected: `--force` would still be the unverifiable bypass). Treat all empty `ls-remote` as local-only (rejected: would hard-retain post-squash-merge trees that `#1274` already handles with bound proof).

### D6: Incomplete implement is not published to review-1

**Decision:** The recipe requires the shared implement-deliverable contract to report satisfied. Unsatisfied + checkpoint → existing completeness (re-invoke implementer). Satisfied + clean → publish.

**Rationale:** `#268` was complete. A mid-implement timeout with a partial salvage must not skip remaining implement work by jumping to review.

**Alternatives:** Always publish any salvage commit (rejected: ships incomplete implement). Always re-invoke implementer after any timeout (rejected: `#268` would re-do finished work and can time out again).

## Risks / Trade-offs

- **[Risk]** Publishing a partial salvage as `review-1`. → **Mitigation:** deliverable-satisfied guard; failing gates still block at the gate.
- **[Risk]** Duplicate PRs if create races a just-created PR. → **Mitigation:** reuse existing create-or-find / exact-branch lookup already specified on implementing-resume.
- **[Risk]** `recover-parked` re-enters a pre-PR human-authority park. → **Mitigation:** re-entry without PR is limited to engine-defect / environment-auth / harness-failure; residual-review and `human-decision-required` still fail-closed or stay parked.
- **[Risk]** Park-release local-only change retains post-squash-merge trees when merge proof is missing. → **Mitigation:** linked merged PR is the second discriminator; bound proof remains condition 2 for release. Missing both stays retain (safer than deleting unpublished work).
- **[Risk]** Same-process publish after a 2400s timeout adds gate time. → **Mitigation:** acceptable; the alternative is a parked unpublished commit. Gates are the validation the decisions require.

## Migration Plan

- No config key, no label rename, no issue-body migration.
- In-flight parks at `implementing` + `blocked` + retained worktree + no PR become recoverable on the next `recover-parked` / single / train recover pass once this ships.
- Rollback: revert the change; prior fail-closed behavior returns. Unpublished commits already retained on disk are not deleted by this change.

## Open Questions

None. Suggested `triage --force` is out of scope. Suggested `#1265` theming is a sibling. Timeout cap stays a config concern, not this recover class.
