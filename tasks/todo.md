# v1.29.2 autonomous recovery regression

## Status
Incident reconstructed. Implementing a provider-neutral recovery controller; the seven child
failures are acceptance fixtures, not seven independent patches.

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

## Review

- Canonical diagnostics distinguish merge/workflow, OpenSpec archive, generated-delta, CI, engine,
  capacity, and attested product/authority decisions without provider branches.
- Recovery is claim-before-side-effect, deadline-backed, restart-idempotent, candidate-bound, and
  redispatches the same item through normal gates. Deferred recovery cannot starve an independent
  sibling, and pushed repair commits reconcile without replaying the implementer.
- Fresh ready/merged/closed truth supersedes stale recovery; human authority expires when the
  reviewed candidate HEAD changes even if the blocked label remains.
- OpenSpec archive success now requires machine-readable success and removal of the active change.
- `openspec validate autonomous-recovery-controller --strict`: passed.
- Focused recovery supervisor/primitive/executor suite: 147 passed, 0 failed.
- `npm run ci`: passed, including 6,136 core tests and 223 OpenSpec items.

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
