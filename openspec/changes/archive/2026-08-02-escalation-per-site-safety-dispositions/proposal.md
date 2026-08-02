## Why

The 2026-07-31 escalation census found ~115 blocker sites, of which ~40–50 escalate with no
bounded recovery attempt: zero-retry `getGhActor` fail-closed blocks, zero-retry pushes, and
worktree-missing parks even when the engine owns rematerialization. PR #787 made
`pipeline/stage-diagnostic@1` the canonical provider-neutral diagnostic, and #814 fixed review
non-convergence authority misrouting — but the repository still lacks a reviewable per-site safety
disposition inventory, still parks some pure infrastructure blips as product blocks, and still
maintains four lossy parallel taxonomies (`BlockerKind`, `HumanInterventionKind`,
`PreMergeOfframpClass`, `DurableBlockerClass`) that do not exhaustively project from one vocabulary.
Blanket retries would reintroduce the damage class of #622/#522; the fix is dispositions first,
then wrappers only where the disposition is `transient-retryable`.

## What Changes

- Record a reviewable **safety disposition per escalation site**: `deliberately-fail-closed`
  (integrity/attestation), `transient-retryable` (bounded retry-with-backoff), or
  `reconcile-owned` (belongs to the reconciler/attempt-ledger layer owned by #759).
- Land the disposition inventory as a normative table in OpenSpec plus a **drift-guard test** that
  every production `setBlocked` (and equivalent blocker/park emitter) declares a disposition.
- Evolve — do **not** replace — the closed `pipeline/stage-diagnostic@1` reason-code set so harness
  and forge failures derive mechanically from structured `HarnessResult` flags and gh error shapes
  (timeout, rate-limit/HTTP 5xx, authentication, capability refusal, output-contract failure,
  external wait, human context, repair-budget exhaustion).
- Make `BlockerKind`, `HumanInterventionKind`, `PreMergeOfframpClass`, and `DurableBlockerClass`
  exhaustive **derived projections** of the canonical reason vocabulary (or retire independent
  authority use of them); loop recovery budgets (#761) SHALL consume the same enum, not a
  parallel fourth-and-a-half taxonomy.
- Add **bounded retry-with-backoff wrappers only** for `transient-retryable` sites: gh reads and
  label mutations that currently fail-closed on 5xx, push after a re-sync currency check, worktree
  rematerialization from the PR branch after a dirty-work check, and pipeline-imposed format
  self-fixes (fix commit subject, impl commit ref, verdict section formats).
- Preserve rigor: review findings, authority decisions, and human-decision-required paths are never
  blindly replayed, suppressed, or overridden. Bounded `remediate → re-review` while budget remains
  is the shipped #787/#814 behavior and remains valid. Mechanical recovery exhaustion stays typed
  and visible and MUST NOT emit `human_intervention` or grant human authority.
- Add a drift guard preventing direct `needs-human` transitions or `human_intervention` emission
  without the canonical authority predicate.

## Acceptance criteria

- [ ] A normative per-site disposition inventory exists under this change and covers the audit's
      escalation census starting set (including zero-retry `getGhActor`, zero-retry push, and
      worktree-missing parks called out in the issue), with each site labeled
      `deliberately-fail-closed`, `transient-retryable`, or `reconcile-owned`.
- [ ] A drift-guard test fails when a new production `setBlocked` (or equivalent blocker/park
      emitter) is added without a declared disposition entry.
- [ ] A gh HTTP 504 (or equivalent transient 5xx) during a label edit classifies as
      `transient-retryable`, exhausts only the configured bounded retry budget, and does **not**
      park the issue as a product/human authority block solely because of that blip.
- [ ] Every escalation that reaches a durable blocker, intervention event, pre-merge off-ramp, or
      loop recovery budget key carries a typed reason code from the single evolved
      `pipeline/stage-diagnostic@1` vocabulary (or an exhaustive pure projection of it).
- [ ] `HumanInterventionKind`, `PreMergeOfframpClass`, and `DurableBlockerClass` are exhaustive
      derived projections of that vocabulary (or are retired as independent classifiers); loop
      recovery budgets key the same closed set.
- [ ] Bounded retry wrappers exist and are unit-tested via injected deps for:
      (a) transient gh read/label paths, (b) push after currency re-sync, (c) worktree rematerialize
      after dirty-work check, (d) pipeline-imposed format self-fix.
- [ ] Integrity/attestation sites (including review-SHA `getGhActor` fail-closed where disposition is
      `deliberately-fail-closed`) remain zero-retry and are not wrapped.
- [ ] Review findings and `human-decision-required` paths never auto-retry as blind replay; a
      valid unresolved correctness finding still routes to engine-owned `review-findings` /
      `implementation-ci` recovery, not human authority, unless current attested authority evidence
      says otherwise.
- [ ] Mechanical recovery exhaustion does not emit `human_intervention` or transition to
      `needs-human` without the canonical authority predicate; a drift guard enforces this.
- [ ] `npm run ci` is green; `plugin/` is regenerated in the same change that edits `core/`.

## Capabilities

### New Capabilities

- `escalation-site-dispositions`: Per-escalation-site safety disposition inventory, disposition
  enum contract, site-class → wrapper eligibility rules, and drift guards for new blocker sites
  and unauthorized human-authority transitions.

### Modified Capabilities

- `autonomous-recovery-controller`: Evolve the closed stage-diagnostic reason-code set and
  mechanical harness/forge classification; keep one vocabulary as the sole authority classifier.
- `durable-blocker-classification`: Make `DurableBlockerClass` an exhaustive derived projection;
  recovery budgets and recipes key that same closed set (unifies the dead parallel taxonomy #761
  revealed).
- `human-intervention-taxonomy`: Make `HumanInterventionKind` a derived projection; keep
  `review-non-convergence` as a reporting dimension only, never as the authority classifier.
- `pre-merge-offramp-classification`: Make `PreMergeOfframpClass` a derived projection of the
  canonical reason vocabulary.
- `blocked-recovery-recipes`: Link every `BlockerKind` / `setBlocked` site to a disposition entry;
  preserve recipe exhaustiveness while adding inventory coupling.
- `gh-transient-retry`: Extend bounded transient retry to dispositioned gh read/label/push call
  sites that currently fail-closed without retry (without touching deliberately-fail-closed sites).
- `worktree-rematerialize`: Ensure worktree-missing escalation sites with disposition
  `transient-retryable` attempt rematerialization (dirty-work checked) before parking.
- `harness-step-verification`: Pipeline-imposed format failures (commit subject, impl commit ref,
  verdict sections) self-correct with a bounded rewrite instead of parking as product holds.
- `loop-needs-human-blocker-disposition`: Drift-guard that direct `needs-human` /
  `human_intervention` paths require the canonical authority predicate.

## Impact

Affects stage blockers across planning/fix/pre-merge/shipcheck/review routing, `stage-diagnostic`
reason projection, intervention emission, pre-merge offramp mapping, durable recovery budgets,
`ghRun`/push/worktree seams, generated `plugin/` mirrors, and unit tests. Does **not** change
review blocking policy, merge authority, or implement the reconciler/attempt-ledger (#759) or
full recovery-recipe execution owned by #761 — those issues consume this vocabulary.
)