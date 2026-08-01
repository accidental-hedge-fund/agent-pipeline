## Why

PR #787 made mechanical blockers recoverable, but resumed v1.29.2 runs still parked #626 and #675
as human decisions. Review history was issue-wide rather than repair-bound, review recovery could
be consumed by label-only retries, persisted contracts kept stale recipes, and reconciliation let
bare PR existence supersede a charged recovery claim.

## What Changes

- Bind review recurrence, surface streaks, and ceiling counts to a verified prior child-run
  `review-N -> fix-N -> actual-next-stage` repair cycle plus candidate movement. Settled-finding
  policy remains scoped to the current child run.
- Route unresolved review non-convergence through a distinct repair-first `review-findings`
  diagnostic/class instead of `needs-human`, stage-local retry, or generic CI redispatch.
- Preserve demote-and-advance only for fully recurring below-high findings; new or mixed blockers
  receive their normal fix round.
- Upgrade resumed recovery policies additively while preserving custom budgets, ordering, and
  immutable run identity; make every advertised engine-defect fallback reachable.
- Keep a blocked ledger item and any started attempt authoritative over bare open-PR discovery;
  only verified ready or merged truth may supersede recovery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `review-loop-recurrence`: recurrence becomes prior-child-run and proven-fix bound and routes to typed
  mechanical recovery rather than human authority.
- `review-surface-recurrence`: surface history uses the same lineage boundary and engine-owned
  disposition.
- `review-ceiling-demote-and-advance`: ceiling evaluation requires recurring blockers; new and
  mixed blockers retain their fix opportunity, while non-demotable recurrence enters recovery.
- `durable-run-reconciliation`: bare open PR state cannot advance a blocked item or orphan a
  started attempt.
- `durable-blocker-classification`: add the distinct review class; resumed contracts add missing
  classes and migrate exact obsolete defaults without overwriting custom policy.
- `blocked-recovery-recipes`: review non-convergence gains a distinct actionable blocker kind.
- `autonomous-recovery-controller`: review non-convergence is explicitly canonicalized as an
  engine-owned recoverable diagnostic.

## Impact

The review comment protocol gains a verified child-run marker. Review routing, stage diagnostic
projection, durable policy migration, reconciliation, supervisor restart behavior, blocker recipes,
generated plugin mirrors, and their incident-shaped tests are affected. No provider-specific logic
or new authority grant is introduced.
