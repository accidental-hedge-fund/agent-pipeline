## 1. Ledger foundation

- [ ] 1.1 Inventory production writers/readers of `.pipeline-rebase-attempted`,
      `pre-merge-ci-recovery.json`, autofix attempt/noop sentinels, commit-prefix attempt inference,
      and in-memory `repairAttempted` / `noRunRecoveryAttemptedForSha` (and duplicates).
- [ ] 1.2 Define the stage-attempt ledger API (`hydrate` / `claim` / `complete` / `supersede` /
      `hasAttempted`) over the extended #787 recovery-attempt record family; no second schema.
- [ ] 1.3 Add/extend record fields: action status, typed reason, budget remaining, last error,
      `next_attempt_at`/`not_before`, idempotency key, terminal outcome.
- [ ] 1.4 Implement injected-deps unit tests for claim-before-side-effect, restart after `started`,
      double-claim rejection, and supersession on HEAD movement.

## 2. Retire stage-local authorities

- [ ] 2.1 Point pre-merge CI recovery (rebase, re-run, archive-fail, assertion-fix, preArchive
      evidence) at the ledger; stop requiring `pre-merge-ci-recovery.json` as authority.
- [ ] 2.2 Point early-conflict and CI rebase bounds at the ledger; stop writing
      `.pipeline-rebase-attempted` as attempt authority.
- [ ] 2.3 Point pre-merge autofix attempt/noop bounds at the ledger; keep attested comments only as
      hydration/attestation inputs, not a parallel book.
- [ ] 2.4 Replace in-memory-only `repairAttempted` / `noRunRecoveryAttemptedForSha` durability with
      ledger hydration (process-local cache of ledger state is fine).
- [ ] 2.5 Add migration one-shot readers for legacy runDir JSON / markers where needed; forbid new
      dual-write of authority after ledger write succeeds.
- [ ] 2.6 Keep salvage/staging exclusions for residual `.pipeline-rebase-attempted` as defense-in-
      depth; update tests that assumed the engine still writes the marker.

## 3. Reconcile-and-converge surfaces

- [ ] 3.1 Implement worktree lifecycle `reconcile(observed) → actions` covering exists/missing/dirty/
      stale/poisoned-mismatched with closed action set.
- [ ] 3.2 Implement review-verdict currency `reconcile(observed) → actions` consuming SHA, internal
      commits, diff-hash, blocking keys, and run-bound recurrence/ceiling evidence.
- [ ] 3.3 Wire create/reclaim/rematerialize call sites through worktree reconcile without weakening
      dirty/local-only reclaim refusals.
- [ ] 3.4 Wire SHA-gate / pre-merge currency decisions through review reconcile; ensure recurrence/
      ceiling cannot apply human hold without current `human-decision-required` authority.
- [ ] 3.5 Ensure child-stage repair and supervisor recovery claims share candidate/finding/action
      identity via the ledger.
- [ ] 3.6 Expose reconcile-shaped exports on pre-merge domain modules (or facades) for CI, conflict,
      SHA-gate, and OpenSpec so #628 can land without private marker books.

## 4. Removal safety consolidation

- [ ] 4.1 Route `auto_recover` and `deploy_ready` worktree removals through `evaluateRemoveSafety`
      or a shared wrapper; add written exemptions only when terminal force-remove is proven safe.
- [ ] 4.2 Ensure parked release evaluates remove safety once (no double independent preflight).
- [ ] 4.3 Add a removal call-site registry/regression test: every production remover is ladder-backed
      or explicitly exempt.

## 5. Regression fixtures and behavior freeze

- [ ] 5.1 Add #769-class fixtures: rematerialize missing tree; refuse poisoned/mismatched tree.
- [ ] 5.2 Add #770-class fixtures: live/manual coexistence does not force unsafe remove or corrupt
      ledger authority.
- [ ] 5.3 Add #626 exact-key recurrence and #675 review-ceiling fixtures as reconciler inputs
      (reuse #814 review-findings routing; do not reimplement review policy).
- [ ] 5.4 Prove existing pre-merge CI / conflict / autofix / OpenSpec guard / review-SHA suites still
      pass under marker retirement (update only intentional authority assertions).
- [ ] 5.5 Prove restart mid-recovery neither double-charges nor free-replays `(headSha, action)`.

## 6. Mirror, validate, and CI

- [ ] 6.1 After any `core/` implementation, run `node scripts/build.mjs` and commit regenerated
      `plugin/` in the same change.
- [ ] 6.2 Run `openspec validate pre-merge-reconcile-and-converge-ledger` and keep it green.
- [ ] 6.3 Run `npm run ci` from repo root and fix all failures before calling the change done.
