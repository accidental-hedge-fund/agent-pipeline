# Post-#787 review recovery regressions

## Status

Implementation, hosted verification, installation, and incident reset complete. Adversarial review rejected the first recurrence model because it used
transitions production never emits and allowed stage-local/no-op recovery to consume the block. The
replacement uses production-shaped repair evidence and a repair-first durable review class.

## Plan

- [x] Bind recurrence and ceiling history to a verified prior review/fix/advance cycle on an older candidate.
- [x] Route genuine review non-convergence through a repair-first durable class, never stage-local retry or human authority.
- [x] Upgrade resumed durable contracts additively while preserving custom entries and making every configured recipe reachable.
- [x] Preserve `blocked` over bare open-PR reconciliation and replay existing started attempts without a second charge.
- [x] Add production-shaped review, policy-migration, reconciliation, and supervisor regressions.
- [x] Regenerate `plugin/` and update the relevant OpenSpec requirements.
- [x] Run focused tests and `npm run ci`.
- [x] Create/upsert GitHub issue ownership, open a `v1.29.2` PR, and verify hosted CI.
- [x] After the fix is merged and installed, reset #626 to `pipeline:fix-1` and #675 to `pipeline:fix-2`.

## Review

- First adversarial pass found fabricated `fix-N -> review-N` fixtures, child-run identity mismatch,
  stage-local auto-loop capture, a no-op `rerun_ci` first action, and an unreachable second engine
  recipe. Shipping stopped before commit; all five findings are part of the replacement design.
- Corrected focused regression suite: 543 passed, 0 failed. Strict OpenSpec validation,
  generated-mirror check, diff check, and full `npm run ci` all passed.
- Second adversarial pass found reviewer-prose injection could forge the standalone run marker.
  Run identity is now a validated `ReviewArtifact` field, with a regression proving legacy injected
  markers remain ineligible for recurrence.
- Adversarial recheck of the artifact-bound fix: no blockers.
- PR #814 hosted CI passed and merge commit `5780f534` was installed for Claude, Codex, and Grok.
  #626 was restored to `pipeline:fix-1`; #675 was restored to `pipeline:fix-2`.

# v1.29.2 autonomous recovery regression

## Status
Implementation and local verification complete. The provider-neutral recovery controller treats
the seven child failures as acceptance fixtures, not seven independent patches.

## Plan
- [x] Reconstruct all seven terminal outcomes from run, loop, GitHub, and engine-identity evidence.
- [x] Prove the common orchestration failure: mechanical blocks became human holds while recovery budgets stayed unused.
- [x] Define a closed human-authority predicate and typed mechanical recovery reasons.
- [x] Wire durable keyed recovery attempts, bounded recipe dispatch, reconciliation, and re-entry into the production supervisor.
- [x] Preserve provider neutrality: stage contracts and recipes, never Claude/Grok/Codex branches.
- [x] Add incident-shaped controller/restart/exhaustion tests.
- [x] Regenerate the `plugin/` mirror.
- [x] Run focused tests and `npm run ci`.
- [x] Replay the seven observed failure classes through controller regression fixtures; all remain
  mechanical and zero produce a false human-authority hold.
- [x] Reconcile a crash after a pushed repair through the idempotent executor without replaying the model.
- [x] Persist recovery eligibility time and keep deferred items from starving schedulable siblings.
- [x] Invalidate candidate-bound human holds when the reviewed HEAD changes, even if `pipeline:blocked` remains.
- [x] Let freshly observed ready, merged, or closed state supersede a stale recovery claim before mutation.
- [x] Rerun focused regressions, regenerate `plugin/`, validate OpenSpec, and rerun `npm run ci`.
- [x] Run deterministic redispatch before model repair for mechanical recovery classes.
- [x] Replace the non-executable authentication recipe with a real credential verification action.
- [x] Route single-issue advancement through the same durable recovery controller as multi-item loops.
- [x] Document the recovery/authority matrix and update stale manual-unblock guidance.
- [x] Add regression coverage, regenerate `plugin/`, and run full CI.
- [x] Push the PR and verify hosted CI.

## Review

- Canonical diagnostics distinguish merge/workflow, OpenSpec archive, generated-delta, CI, engine,
  capacity, and attested product/authority decisions without provider branches.
- Recovery is claim-before-side-effect, deadline-backed, restart-idempotent, candidate-bound, and
  redispatches the same item through normal gates. Deferred recovery cannot starve an independent
  sibling, and pushed repair commits reconcile without replaying the implementer.
- Fresh ready/merged/closed truth supersedes stale recovery; human authority expires when the
  reviewed candidate HEAD changes even if the blocked label remains.
- OpenSpec archive success now requires machine-readable success and removal of the active change.
- Deterministic recovery runs before model repair; authentication recovery performs a live
  credential check instead of claiming a no-op recipe succeeded.
- Single-issue host invocations now enter the same durable recovery controller as milestone loops,
  and unattested `needs-human` outcomes remain engine-owned regardless of labels or stale comments.
- `openspec validate autonomous-recovery-controller --strict`: passed.
- Focused host/supervisor regression suite: 129 passed, 0 failed.
- `npm run ci`: passed, including 6,190 core tests and 223 OpenSpec items.
- PR #787 hosted `ci/test`: passed.

# #771 — pre-merge CI settled failure must not thrash

## Status
Implementation complete. OpenSpec tasks all checked; `npm run ci` green.

## Plan artifacts
- `openspec/changes/pre-merge-ci-settled-failure-no-thrash/` (proposal, design, tasks, specs)

## Done
- Durable per-head rebase markers (`ciRebaseAttemptedForSha`) + terminal fail marker
- HEAD-moved truthfulness for CI ladder, BEHIND, and conflict recovery
- Thrash regressions in `core/test/pre-merge-ci-recovery.test.ts`
- Regenerated `plugin/` mirror
