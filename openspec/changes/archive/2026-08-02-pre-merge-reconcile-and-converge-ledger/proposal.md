## Why

Recovery and worktree lifecycle decisions are still scattered across stage-local one-shot markers
and unguarded removal paths. After PR #787 (outer autonomous recovery controller) and PR #814
(review-recovery routing fix), the residual failure mode is structural: pre-merge and worktree
code still infer attempt state from five parallel persistence mechanisms and ~11 reusable-vs-
recreate decision sites, so the same classes recur after each point fix (archive, delta/SHA-gate,
salvage, worktree). #759 is the structural consolidation layer: one durable attempt ledger and
one reconcile-and-converge invariant shape — not another special-case marker.

## What Changes

- **Single durable attempt ledger** keyed `(headSha, action)` (and candidate/run identity where
  applicable), extending the shipped #787 recovery-attempt record rather than inventing a second
  ledger. One read/write hydration API; action status, typed reason (#760), attempt budget, last
  error, `next_attempt_at`, idempotency key, and terminal outcome are first-class fields.
  Execution and hydration remain idempotent across process restart and cross-host resume.
- **Retire the five stage-local mechanisms** as authorities:
  1. untracked worktree file (`.pipeline-rebase-attempted`)
  2. runDir JSON (`pre-merge-ci-recovery.json` fields such as `preArchiveSha`,
     `ciRerunAttempted*`, `ciArchiveFailRecoveryAttempted*`, `ciAssertionFixAttempted*`)
  3. pre-merge autofix GitHub comment sentinels as *sole* attempt authority
     (`pipeline-pre-merge-autofix-attempt` / `-noop`) — GH comments may remain attestation
     surfaces only when the ledger hydrates from them
  4. commit-subject prefix inference as sole attempt authority
  5. in-memory flags (`noRunRecoveryAttemptedForSha`, duplicated `repairAttempted`) as sole
     durability
- **Generalize the `enforceOpenspecActiveChangeGuard` shape** (derive true state from the
  authoritative tree/candidate → repair toward the invariant) to:
  - **worktree lifecycle** (exists / missing / dirty / stale / poisoned-mismatched →
    recreate / salvage / repair / retain decisions in one place)
  - **review-verdict currency** (reuse vs re-review vs hold inputs from reconciled state, not
    stage-local terminalization)
- **Every worktree-removal path** routes through `evaluateRemoveSafety`, or carries a written
  exemption comment stating why terminal force-remove is safe at that site (including
  `auto_recover`, `deploy_ready`, and parked release; no double-evaluation of the same policy
  without a single decision).
- **Stage-local terminalization converges through the ledger/supervisor**: review/fix round
  counts, finding fingerprints, and recurrence evidence are reconciler inputs, not independent
  authority to apply `pipeline:needs-human`. Child-stage repair attempts share candidate /
  finding / action identity with supervisor recovery claims. Only current
  `human-decision-required` authority evidence may converge to a human hold.
- **Behavior-freeze** for product outcomes where possible: consolidate authority and convergence
  shape without adding new recovery capabilities or recipe automation (#761/#787 ownership).
- **Regression fixtures** derived from recurrence chains and closed #769 / #770 / #626 / #675
  classes; injected-deps unit tests only.

## Capabilities

### New Capabilities

- `stage-attempt-ledger`: Unified durable attempt ledger for stage-local and supervisor-shared
  recovery actions — single API, extended #787 record fields, retirement of parallel markers.
- `reconcile-and-converge`: Observe authoritative state → derive actions → converge to invariant
  for worktree lifecycle and review-verdict currency (generalization of the OpenSpec active-
  change guard shape).

### Modified Capabilities

- `autonomous-recovery-controller`: Extend the recovery-attempt record contract with action
  status, typed reason, budget, last error, `next_attempt_at`, idempotency key, and terminal
  outcome; require stage-local recoveries to share the same identity space rather than parallel
  books.
- `pre-merge-ci-gate`: CI recovery one-shots and pre-archive evidence hydrate from the stage
  attempt ledger; `pre-merge-ci-recovery.json` is no longer the authority.
- `pre-merge-conflict-detection`: Rebase-attempt bounds use the ledger, not a worktree-local
  `.pipeline-rebase-attempted` marker file as sole authority.
- `pre-merge-fix-round`: Autofix attempt/noop bounds use the ledger (GH sentinels may attest
  but do not form a separate attempt book).
- `harness-uncommitted-salvage`: Engine SHALL NOT write worktree-local attempt-marker files;
  salvage keeps defense-in-depth exclusion for residual legacy marker paths.
- `worktree-staging-exclusions`: Same retirement of the worktree-local attempt marker as a
  production write path.
- `worktree-lifecycle`: Worktree create/reclaim/reuse decisions go through the reconcile layer;
  removal/reclaim remains safety-gated via `evaluateRemoveSafety`.
- `worktree-per-run-removal`: Document/enforce that all removal call sites share the safety
  ladder (no unguarded force-remove without written exemption).
- `parked-item-worktree-release`: Parked release evaluates remove safety once via the shared
  ladder (no double-evaluation fork).
- `worktree-rematerialize`: Missing/poisoned/mismatched tree handling is a reconcile action
  bound to ledger attempts (#769 class).
- `review-sha-gating`: Verdict currency is a reconcile input/output; stage-local ceiling or
  recurrence inference does not independently terminalize to human hold.
- `pre-merge-module-boundary`: Domain modules expose `reconcile(state) → actions` rather than
  only linear gate order (coordinates with #628 without owning the full split).

## Impact

- **Code (intent only this step):** stage attempt ledger module; pre-merge CI / conflict /
  autofix / OpenSpec / SHA-gate consumers; worktree lifecycle + remove sites
  (`worktree.ts`, `auto_recover.ts`, `deploy_ready.ts`, parked release); shared identity with
  supervisor recovery claims; generated `plugin/` mirror after `core/` edits.
- **Tests:** injected-deps regressions for marker retirement, ledger idempotency/restart,
  remove-safety coverage, worktree rematerialize/poisoned tree (#769), live/manual coexistence
  (#770), #626 exact-key recurrence and #675 review-ceiling fixtures as reconciler inputs.
- **Boundaries preserved:** #761/#787 own scheduling and recipe execution; #814 review-findings
  class and controller remain the review routing path — this change reuses them, does not
  reimplement review routing. No new recovery recipes, no auto-merge, no authority widening.
- **Out of scope:** New recovery capabilities/automation; the full pre_merge module split
  implementation body (#628) beyond requiring reconcile-shaped surfaces; unattended merge.

## Acceptance criteria

Observable, falsifiable outcomes that make #759 done:

- [ ] A single attempt-ledger read/write API exists and is the sole production authority for
      pre-merge CI recovery one-shots, rebase attempt bounds, autofix attempt/noop bounds, and
      OpenSpec/archive repair-attempt bounds previously stored in the five mechanisms above.
- [ ] Production code paths no longer treat `.pipeline-rebase-attempted` as required durable
      attempt state; the engine does not write that file as an attempt marker on new runs.
- [ ] Production code paths no longer require `pre-merge-ci-recovery.json` as authority for
      `ciRerun` / `ciArchiveFail` / `ciAssertionFix` / related one-shots (file may be absent or
      read only for migration).
- [ ] Autofix GitHub comment sentinels and commit-subject prefixes are not sole attempt
      authorities; restart without in-memory flags still honors prior attempts via ledger
      hydration (including cross-host-safe attestation where required).
- [ ] Unit test: process restart mid-recovery rehydrates the same `(headSha, action)` attempt
      without double-charging or silent free replay.
- [ ] Unit test: worktree reconcile covers exists / missing / dirty / stale / poisoned-
      mismatched and emits create/salvage/repair/retain actions without scattering decisions
      across independent call sites (#769 class).
- [ ] Unit test: every production worktree-removal call site either invokes
      `evaluateRemoveSafety` (or a single wrapper that does) or is annotated with a written
      exemption that tests assert is present; `auto_recover` and `deploy_ready` are included.
- [ ] Unit test: parked worktree release does not evaluate the same remove-safety policy twice
      as two independent authorities.
- [ ] Unit test: review recurrence / ceiling evidence is reconciler input and cannot apply
      `pipeline:needs-human` without current `human-decision-required` authority (#626 / #675
      class fixtures).
- [ ] Unit test: child-stage repair and supervisor recovery claims share candidate/finding/
      action identity so restart cannot suppress, duplicate, or bypass recovery.
- [ ] Live/manual invocation coexistence (#770 class) does not corrupt ledger authority or
      force unsafe worktree removal.
- [ ] Behavior-freeze: existing green pre-merge CI, conflict, autofix, OpenSpec guard, and
      review-SHA gate regression suites remain the oracle unless a scenario is intentionally
      updated for marker retirement.
- [ ] `openspec validate pre-merge-reconcile-and-converge-ledger` passes; implementation lands
      with `npm run ci` green and regenerated `plugin/` when `core/` changes.
