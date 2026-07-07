## Context

`shipcheck-gate` is reached only via the forward flow `pre-merge → (eval-gate) →
shipcheck-gate`. By the time pre-merge advances an issue forward, the PR head was
CI-green, conflict-free, and review-SHA-validated, and eval ran on that head. So
the head that *legitimately* reaches shipcheck is the head pre-merge blessed.

The bug is that nothing re-establishes that invariant on **re-entry**. After a
gate-mode block (`shipcheck-failed`), the operator fixes the code and re-runs; the
issue is still on `pipeline:shipcheck-gate`, so the loop dispatches straight back
into `shipcheck.advance`, which re-runs the reviewer and (on pass) transitions to
`ready-to-deploy`. The reviewer runs inside the worktree, so it blesses the
operator's local fix whether or not it was pushed, and the upstream gates never
see the new head.

## Goals / Non-Goals

- **Goal:** a post-shipcheck code fix is re-validated through pre-merge/eval/
  review-SHA before `ready-to-deploy`.
- **Goal:** never mark a stale PR ready — block when the worktree head differs
  from the PR head.
- **Non-Goal:** auto-recovering shipcheck failures. A failing shipcheck verdict
  remains a human-disposition hard stop (`isAutoLoopEligible` keeps `shipcheck-gate`
  ineligible). This change only hardens the *manual* fix-and-rerun path.
- **Non-Goal:** changing the #302 taxonomy/intervention recording, the rubric, the
  verdict schema, or advisory/gate verdict semantics.

## Decisions

### 1. Route a post-verdict fix back to `pre-merge` (not `review-2`)

`pre-merge` is the single entry point that already re-runs the full late-stage
chain: CI status checks, the review-SHA gate (which itself runs the focused delta
review on the unreviewed commits), and then forward-routes through `eval-gate`
back to `shipcheck-gate`. Routing shipcheck → pre-merge reuses that proven
machinery wholesale instead of duplicating CI/eval/review-SHA logic inside
shipcheck. It also matches the issue's stated direction ("route ... back through
pre-merge/eval/review-SHA validation").

### 2. Anchor re-validation on a `shipcheck-sha` sentinel, classified with
`isPipelineInternalCommit`

shipcheck embeds the PR head SHA it evaluated in its verdict comment as
`<!-- shipcheck-sha: <full-sha> -->`, mirroring `review-sha-gating`'s
`<!-- reviewed-sha: … -->`. On re-entry the gate reads the most recent shipcheck
comment authored by the authenticated `gh` actor and compares its recorded SHA to
the current PR head.

A self-owned sentinel (rather than reusing the review comment's `reviewed-sha`) is
**config-independent**: it works even when standard/adversarial review is disabled,
so the re-validation guard never silently no-ops on a review-disabled repo. It is a
small, well-understood surface that copies an existing pattern.

The SHA difference is classified with `isPipelineInternalCommit` (exported from
`pre_merge.ts`): a head move whose only commits are pipeline-internal (the OpenSpec
archive commit pre-merge itself pushes) does **not** trigger a route-back. Only a
developer/fix commit since the recorded SHA does. This is what prevents a
non-converging loop (see Convergence below) and reuses the same exemption the
review-SHA gate relies on (#98).

### 3. `head-drift` as a dedicated `BlockerKind`

The unpushed-fix case is structurally distinct from every existing blocker: the
recovery is `git push`, not "fix findings" or "clear the label". The
`blocked-recovery-recipes` capability explicitly assigns one `BlockerKind` +
recipe per distinct failure class, so a `head-drift` kind with a push-the-fix
recipe is the consistent, honest choice. Reusing `needs-human` would render the
wrong recovery instructions. `head-drift` maps to the
`merge-conflict-or-branch-drift` human-intervention kind (it is branch drift).

### 4. The gate runs before the reviewer, on the enabled path only

Running the head-coherence checks before invoking the reviewer means a route-back
or a head-drift block costs one `getPrDetail` + one `git rev-parse` rather than a
full reviewer invocation. The checks gate every enabled-path advance to
`ready-to-deploy` (both advisory and gate modes), because both modes bless the PR
head — head drift and an unvalidated head are *structural* integrity failures, not
rubric verdicts, so blocking on them does not violate the advisory contract (which
governs the rubric verdict only).

The disabled-shipcheck skip path (`!cfg.shipcheck_gate.enabled` → silent
transition to `ready-to-deploy`) is **out of scope**: shipcheck can only strand an
issue when it is enabled in gate mode, so the recovery scenario never lands an
issue on a disabled shipcheck-gate with local drift. Leaving the skip path
untouched keeps the change minimal and avoids surprising disabled-shipcheck repos.

### 5. Graceful degradation

- **No worktree** for the issue → the worktree-vs-PR-head comparison is skipped
  (no local head to compute), consistent with shipcheck already falling back to
  `cfg.repo_dir`. The re-validation routing still applies (it needs only PR data
  and comments).
- **No linked PR** → both head checks are skipped, matching shipcheck's existing
  null-PR tolerance. (Reaching shipcheck without a PR is already an anomaly:
  pre-merge blocks `no-pull-request` first.)

## Convergence / loop safety

The route-back fires only when a developer/fix commit landed since the recorded
`shipcheck-sha`. Trace of the recovery path:

1. First shipcheck entry at head `H1` (post-archive, pre-merge-blessed). Verdict
   comment records `H1`. Gate mode `fail` → blocked `shipcheck-failed`.
2. Operator fixes, **pushes** → PR head `H2`; clears `blocked`; re-runs.
3. Re-entry: worktree HEAD == `H2` == PR head (push happened) → no head-drift
   block. Prior `shipcheck-sha` = `H1` ≠ `H2`, commit `H1..H2` is a developer
   commit → route `shipcheck-gate → pre-merge`.
4. pre-merge re-runs CI on `H2`, review-SHA delta review on `H1..H2`, archive is
   idempotent (already in history), forward-routes eval → shipcheck on `H2`.
5. shipcheck at `H2`: prior `shipcheck-sha` is still `H1`? No — step 4's forward
   pass records `H2` only when it *advances*. On this pass the recorded SHA is the
   stale `H1` until shipcheck completes; the guard compares `H1` vs current head
   `H2` and would route back again. **To avoid this, the gate treats "current PR
   head == worktree-validated head that just arrived from pre-merge" correctly:**
   the route-back compares against the *prior* shipcheck comment's SHA, and on the
   pass that follows a pre-merge round shipcheck must write the new `H2` sentinel
   and proceed.

   The simple, robust rule that converges: route back **once** per new developer
   head. After routing back, pre-merge's review-SHA gate re-reviews `H1..H2` and
   re-anchors the review verdict at `H2`; when control returns to shipcheck, the
   gate posts a fresh verdict comment recording `H2`. The next time shipcheck is
   entered for `H2` the recorded `shipcheck-sha` equals the head, so it proceeds.
   No new developer commit ⇒ no further route-back. Implementation note: to make
   "route back once" precise, the guard ignores a recorded SHA only when a
   non-pipeline-internal commit separates it from HEAD; identical-head and
   internal-only moves always proceed.

If the operator **did not push** (step 2 variant), worktree HEAD `H2` ≠ PR head
`H1` → head-drift block; no transition, no loop. The operator pushes and the
push-then-rerun lands on the converging path above.

## Risks / Mitigations

- **Spurious route-back loop.** Mitigated by the `isPipelineInternalCommit`
  classification (archive commits never route back) and by recording the evaluated
  SHA so an unchanged head proceeds. Covered by an explicit "head unchanged →
  proceed" and "internal-only → proceed" test.
- **Forged shipcheck comment.** The sentinel is only read from comments authored
  by the authenticated `gh` actor (`getGhActor`), matching the review-SHA gate's
  provenance rule (#228/#229). A non-actor commenter cannot suppress or trigger a
  route-back.
- **`getPrDetail`/`gh` transient failure during the gate.** Treated
  conservatively: a failure to determine the PR head or worktree head must not
  silently advance — the gate surfaces the error (block/needs-human) rather than
  blessing an unverified head.

## Testing approach

Unit tests inject the `gh`/worktree seams (no real network/git), following
`ShipcheckDeps`. They assert: (a) worktree-head ≠ PR-head → blocked `head-drift`,
not advanced; (b) prior `shipcheck-sha` ≠ head with a developer commit →
transition to `pre-merge`, not `ready-to-deploy`; (c) head unchanged / internal-
only / first-entry → proceeds; (d) the verdict comment carries the
`shipcheck-sha` sentinel; (e) `blockerKindToInterventionKind("head-drift")`
mapping. Each new guard test is proven to fail with the guard removed.
