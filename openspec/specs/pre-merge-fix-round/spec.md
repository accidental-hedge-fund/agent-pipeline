# pre-merge-fix-round Specification

## Purpose
TBD - created by archiving change pre-merge-fix-round. Update Purpose after archive.
## Requirements
### Requirement: Pre-merge SHALL gate the auto-fix on a fixed finding-category allowlist

The pipeline SHALL partition blocking pre-merge delta-review findings into an **auto-fixable**
subset and a **residual human-required** subset using the fixed category allowlist
`{ correctness, missing-dep, concurrency }` (case-insensitive, trimmed). A finding is
auto-fixable if and only if its `category` is in that allowlist. A finding is residual
human-required when its category is outside the allowlist — including `security`, `scope`,
`product-judgment-required`, `spec-divergence`, `data-loss`, `observability`, an unrecognized
token, or an absent/empty category (fail-closed for that finding).

The pipeline SHALL attempt the bounded pre-merge auto-fix when **all** of the following hold:
the auto-fixable subset is non-empty; an implementer harness is configured; and no prior
auto-fix attempt is recognized for the entry (prefix commit or durable attempt/noop marker).
The presence of residual human-required findings in the **same** blocking batch SHALL NOT by
itself veto the auto-fix attempt for the auto-fixable subset (**partition**, not
all-or-nothing). When the auto-fixable subset is empty, the pipeline SHALL skip the auto-fix
harness and escalate to `needs-human` without a harness call.

The auto-fix attempt SHALL be scoped to the auto-fixable subset only: residual findings SHALL
NOT be included in the fix prompt. Residual findings remain subject to human disposition when
they still block after the attempt (or immediately when no auto-fixable subset exists). The
living allowlist membership and rationale remain the category matrix requirement; expansions
require an OpenSpec change and tests, not an undocumented string add.

#### Scenario: all blocking findings are correctness — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `correctness`, `missing-dep`, or `concurrency`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt (see the bounded-attempt
  requirement) rather than escalating to `needs-human`

#### Scenario: all blocking findings are concurrency — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `concurrency`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt rather than escalating
  to `needs-human` on the first hop

#### Scenario: mixed allowlisted categories remain eligible

- **WHEN** the blocking findings include only categories from
  `{ correctness, missing-dep, concurrency }` (any non-empty combination)
- **AND** no prior auto-fix commit exists for the entry
- **THEN** the pipeline SHALL treat the set as auto-fixable and attempt one auto-fix

#### Scenario: mixed allowlisted and residual non-allowlisted — partition attempts auto-fix

- **WHEN** the blocking findings include at least one allowlisted category
  (`correctness`, `missing-dep`, or `concurrency`)
- **AND** at least one residual non-allowlisted category (for example `spec-divergence`,
  `security`, `scope`, or `product-judgment-required`)
- **AND** no prior auto-fix attempt is recognized for the entry
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL attempt exactly one bounded auto-fix scoped to the allowlisted
  subset
- **AND** SHALL NOT skip the auto-fix solely because residual non-allowlisted findings are
  co-batched
- **AND** residual findings SHALL NOT be included in the auto-fix prompt

#### Scenario: #729-shaped concurrency + spec-divergence still attempts auto-fix

- **WHEN** the blocking findings are a HIGH `concurrency` finding and a HIGH `spec-divergence`
  finding (co-batched under the same delta verdict)
- **AND** no prior auto-fix attempt is recognized for the entry
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL invoke the auto-fix harness once for the `concurrency` subset
- **AND** SHALL NOT first-hop to `needs-human` without an auto-fix attempt solely because of
  the co-batched `spec-divergence` finding

#### Scenario: pure residual non-allowlisted batch — escalate without auto-fix

- **WHEN** every blocking finding has a residual non-allowlisted category (including
  `security`, `scope`, `product-judgment-required`, `spec-divergence`, `data-loss`,
  `observability`, or absent/empty/unrecognized)
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` without a harness call

#### Scenario: pure security-only batch still escalates without auto-fix

- **WHEN** the only blocking findings have `category` `security`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately

#### Scenario: residual after partial auto-fix still needs human

- **WHEN** a mixed batch receives one bounded auto-fix attempt on the allowlisted subset
- **AND** the single post-fix re-delta (or post-noop re-verify) still reports residual
  non-allowlisted blocking findings and/or still-blocking allowlisted findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness a second time
- **AND** the block reason SHALL name which keys/categories required human disposition versus
  which were auto-fix attempted

### Requirement: Pre-merge SHALL perform at most one auto-fix attempt per entry

The pipeline SHALL perform at most one implementer auto-fix attempt for a pre-merge blocking delta
review at a given authoritative candidate identity. In the pre-merge stage the durable attempt key
SHALL be the issue plus the candidate head SHA, recorded as a trusted pipeline-attested
attempt-started (or noop-clean) PR comment marker and detectable via the auto-fix commit-subject
prefix — not a worktree marker alone. On the durable loop supervisor's repair path the ledger
attempt SHALL be keyed by item, candidate identity, evidence fingerprint, and repair action.
Candidate-currency checks, worktree lookup, safe rematerialization, synchronization, and clean-tree
checks SHALL be preflight and SHALL NOT consume the implementer repair attempt. Immediately before
invoking the implementer, the pipeline SHALL durably claim and charge the attempt. A successful
commit, confirmed clean no-op, harness failure, timeout, unsafe no-action, or process death after
claim SHALL consume that attempt. After a successful commit the pipeline SHALL re-run delta review
exactly once against the new head. After a clean no-op it SHALL re-verify exactly once. A candidate
identity change SHALL supersede the old attempt and require fresh eligibility computation; it SHALL
not mutate or replay the old candidate.

#### Scenario: Fix resolves the finding and pre-merge proceeds

- **WHEN** a claimed auto-fix commits a repair and the single re-run delta review approves under
  active policy
- **THEN** pre-merge SHALL proceed without another auto-fix attempt for the old candidate
- **AND** the prior evidence SHALL remain bound to that candidate

#### Scenario: Fix does not resolve the finding and consumes the attempt

- **WHEN** a claimed auto-fix commits but the single re-run still reports blocking findings
- **THEN** the keyed attempt SHALL remain consumed
- **AND** the item SHALL return a typed blocked diagnostic without a second implementer invocation

#### Scenario: Prior charged attempt is recognized after restart

- **WHEN** a prior auto-fix commit subject, or a trusted attested attempt-started or noop-clean
  marker, exists for the same issue and candidate head — or, on the durable supervisor's repair
  path, the ledger contains a claimed or completed attempt for the same item, candidate identity,
  evidence fingerprint, and action
- **AND** the finding remains blocking
- **THEN** the pipeline SHALL NOT invoke the implementer again for that key
- **AND** it SHALL reconcile the recorded attempt result before choosing the next disposition

#### Scenario: Prior clean no-op is reverified without a second attempt

- **WHEN** a charged attempt at the current candidate ended in confirmed clean no-op
- **AND** the finding remains under evaluation
- **THEN** the pipeline SHALL run the single current-head reverify path
- **AND** it SHALL NOT invoke the implementer again for that key

#### Scenario: Process death after claim does not grant a free retry

- **WHEN** the process dies after charging the attempt and before recording its result
- **THEN** resume SHALL reconcile live candidate and postconditions against that attempt
- **AND** it SHALL not create an uncharged second implementer attempt

#### Scenario: Preflight failure does not consume implementer repair

- **WHEN** candidate-currency, rematerialization, synchronization, or clean-tree preflight fails
  before the implementer claim
- **THEN** no implementer repair unit SHALL be consumed
- **AND** the preflight failure SHALL surface its own diagnostic — a typed `worktree-missing`,
  `worktree-capacity`, or `worktree-creation-failed` blocker for rematerialization failures, and
  the auto-fix error outcome for a dirty pre-fix tree

#### Scenario: Claim persistence failure prevents implementer invocation

- **WHEN** the pipeline cannot durably claim and charge the attempt
- **THEN** it SHALL NOT invoke the implementer harness
- **AND** it SHALL return a typed engine-owned persistence failure

### Requirement: The pre-merge auto-fix SHALL reuse the surgical-fix prompt and roll back on failure

The auto-fix attempt SHALL invoke the implementer harness with the surgical-fix prompt
(`buildFixPrompt`, #235) scoped to the **auto-fixable** blocking delta-review findings (the
allowlisted partition subset), run from the issue worktree, so the minimal-diff discipline, the
destructive-operation guard, and the pre-commit self-check apply unchanged. Residual
non-allowlisted findings SHALL NOT be passed into that fix prompt. The attempt SHALL require a
clean worktree before starting (fail closed otherwise). On harness error, a worktree left
dirty/uncommitted with no successful salvage, or an ambiguous partial state, the pipeline SHALL
roll the worktree back to the pre-fix HEAD over a clean tree and escalate to `needs-human`; it
SHALL NOT push a partial fix. A confirmed clean no-commit outcome
(`headAfter === headBefore`, worktree clean, nothing salvageable) is **not** treated as an immediate
hard block: the pipeline SHALL return a distinct noop-clean outcome (see clean-noop re-verify
requirement) after any no-op rollback, and the caller SHALL re-verify rather than set `blocked` solely
from the absence of a commit.

#### Scenario: auto-fix prompt is the surgical-fix prompt

- **WHEN** the pipeline builds the pre-merge auto-fix prompt
- **THEN** it SHALL use `buildFixPrompt` output (not a looser prompt), carrying the minimal-diff
  instruction, the destructive-operation guard, and the pre-commit self-check

#### Scenario: mixed-batch prompt excludes residual non-allowlisted findings

- **WHEN** the blocking set partitions into non-empty auto-fixable and residual subsets
- **AND** the pipeline builds the pre-merge auto-fix prompt
- **THEN** the prompt findings SHALL include only the auto-fixable subset
- **AND** SHALL NOT include residual non-allowlisted findings

#### Scenario: harness failure with dirty or partial state rolls back and escalates

- **WHEN** the auto-fix harness invocation fails with a dirty worktree that is not successfully
  salvaged, or leaves an ambiguous partial state that is not a confirmed clean no-commit
- **THEN** the pipeline SHALL restore the pre-fix HEAD over a clean worktree
- **AND** SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT push a partial fix to the PR head

#### Scenario: dirty worktree before the attempt fails closed

- **WHEN** the worktree has uncommitted changes before the auto-fix attempt starts
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL escalate to `needs-human` without mutating git state

#### Scenario: confirmed clean no-commit is noop-clean, not immediate needs-human

- **WHEN** the auto-fix harness exits with `headAfter === headBefore` and a clean worktree with
  nothing salvageable
- **THEN** the pipeline SHALL expose a distinct noop-clean outcome (not a generic unrecoverable
  error alone)
- **AND** SHALL NOT set `blocked`/`needs-human` solely because no commit was produced
- **AND** SHALL proceed to the clean-noop re-verify path

### Requirement: The pre-merge auto-fix commit SHALL be developer-classified and traceable

The auto-fix commit SHALL carry the run's `Issue: #N` and `Pipeline-Run: <id>` git trailers and
SHALL be classified as a developer commit, so the review-SHA gate re-reviews it. `isPipelineInternalCommit`
(from the neutral pipeline-commits module) SHALL continue to return `false` for the auto-fix commit
subject; the recognizable marker used by the one-attempt bound (a commit-subject prefix or dedicated
trailer) SHALL NOT cause `isPipelineInternalCommit` to return `true`.

#### Scenario: auto-fix commit carries traceability trailers

- **WHEN** the auto-fix attempt commits a fix
- **THEN** the commit message SHALL include `Issue: #<issue-number>` and `Pipeline-Run: <run-id>`
  trailers

#### Scenario: auto-fix commit is not pipeline-internal

- **WHEN** `isPipelineInternalCommit` is called with the auto-fix commit subject
- **THEN** it SHALL return `false`
- **AND** the review-SHA gate SHALL treat the auto-fix commit as a developer commit that invalidates
  the prior verdict and triggers the re-review

### Requirement: The pre-merge auto-fix re-review SHALL NOT consume a review-2 ceiling slot

The single re-run of the delta review after an auto-fix commit SHALL NOT increment the
`max_adversarial_rounds` counter, consistent with the existing rule that pre-merge delta reviews do
not consume a review-2 ceiling slot. The issue's review-2 budget SHALL be preserved for full review-2
rounds.

#### Scenario: re-review preserves the review-2 budget

- **WHEN** the pipeline re-runs the delta review after an auto-fix commit
- **THEN** the `max_adversarial_rounds` counter SHALL NOT be incremented
- **AND** the issue's review-2 ceiling budget SHALL be unchanged by the auto-fix round

### Requirement: The pre-merge auto-fix behavior SHALL be covered by regression tests

The test suite SHALL cover the pre-merge auto-fix path using the existing dependency-injection seams (no real harness, git, or network). The tests SHALL cover: a blocking all-`correctness` review that is auto-fixed and then advances; a blocking all-`concurrency` review that is auto-fixable (eligible → auto-fix path); a pure residual `product-judgment-required` (or `security`) review that escalates without an auto-fix; a **mixed** allowlisted + residual batch (including a #729-shaped `concurrency` + `spec-divergence` fixture) that still attempts auto-fix for the allowlisted subset and does not skip solely due to the residual category; the one-attempt bound after a prior auto-fix commit; the developer classification of the auto-fix commit; and — driving the fix-then-re-review path — that the second (post-fix) review invocation receives a diff **distinct** from the first review invocation and that the re-review is anchored to the post-fix head (recorded `reviewed-sha` equals the auto-fix commit SHA, not the pre-fix SHA). Each test SHALL fail (bite) if the corresponding behavior is removed.

#### Scenario: auto-fix regression tests bite

- **WHEN** the eligibility-and-attempt branch is removed so the delta-review block path
  escalates directly to `needs-human`
- **THEN** at least the all-`correctness`-advances test, the all-`concurrency`-eligible test, and
  the one-attempt-bound test SHALL fail

#### Scenario: partition mixed-batch regression tests bite

- **WHEN** eligibility is reverted to all-or-nothing (`allBlockingAutoFixable` / every-finding
  must be allowlisted) so a mixed concurrency + `spec-divergence` batch skips the harness
- **THEN** the unit test asserting auto-fix is still attempted for the allowlisted subset
  SHALL fail
- **AND** the #729-shaped fixture regression SHALL fail

#### Scenario: concurrency allowlist expansion test bites

- **WHEN** `isAutoFixableFinding` is reverted so `concurrency` is treated as non-allowlisted
- **THEN** the unit test asserting `concurrency` is auto-fixable SHALL fail
- **AND** any gate-path test that expects a concurrency-only blocking set to attempt auto-fix
  SHALL fail

#### Scenario: pure residual escalation regression test bites

- **WHEN** the category allowlist is widened to treat `product-judgment-required` as auto-fixable
- **THEN** the escalation test for pure `product-judgment-required` SHALL fail

#### Scenario: post-fix re-review regression test bites

- **WHEN** the re-review's post-fix head is resolved from the stale GitHub-API PR-head read
  instead of the authoritative local post-fix head (regressing the fix)
- **THEN** the test asserting the second review invocation receives a different diff than the
  first — anchored to the post-fix head — SHALL fail

#### Scenario: final revalidation regression test bites

- **WHEN** the post-approval HEAD revalidation is reverted to block on any mismatch between
  the GitHub-API PR-head read and the auto-fix commit SHA, without tolerating the known
  pre-fix head as staleness
- **THEN** the test asserting a stale GitHub-API read of the pre-fix head does not veto an
  approving post-fix re-review SHALL fail

### Requirement: The pre-merge auto-fix re-review SHALL evaluate the post-fix head diff

The single delta re-review that follows a successful pre-merge auto-fix commit SHALL
evaluate the diff **including** that auto-fix commit. The pipeline SHALL determine the
post-fix head from the **authoritative local git state** — the SHA of the auto-fix commit
as produced in the issue worktree, carried back from the successful auto-fix result — and
SHALL NOT resolve the post-fix head from a GitHub-API PR-head read (`gh pr view
--json headRefOid` / `getPrDetail`), which can return the stale pre-fix head in the window
immediately after the push. The re-review's delta diff SHALL be computed over
`reviewed-sha...<post-fix-head>` against a git source that contains the auto-fix commit
object, and the re-review verdict comment SHALL record its `reviewed-sha` and
`verdict-diff-hash` sentinels against that same post-fix head.

#### Scenario: Re-review diff includes the auto-fix commit

- **WHEN** a pre-merge auto-fix commits a fix and the pipeline re-runs the delta review once
- **THEN** the diff presented to the re-review SHALL be `reviewed-sha...<post-fix-head>`,
  where `<post-fix-head>` is the auto-fix commit SHA from local git state
- **AND** the re-review diff SHALL differ from the pre-fix delta diff evaluated by the first
  review whenever the auto-fix changed the tree

#### Scenario: Re-review does not use a stale GitHub-API PR head

- **WHEN** the GitHub-API PR-head read returns the pre-fix head immediately after the
  auto-fix push (stale read)
- **THEN** the pipeline SHALL still use the authoritative local post-fix head for the
  re-review diff range and the recorded `reviewed-sha`
- **AND** the recorded `reviewed-sha` SHALL equal the post-fix head, never the pre-fix SHA

#### Scenario: A resolved finding does not re-block

- **WHEN** the auto-fix applied the recommended remediation and the post-fix delta diff no
  longer exhibits the blocking finding
- **THEN** the re-review over the post-fix diff SHALL NOT re-emit that finding as blocking
- **AND** the pipeline SHALL proceed (pre-merge advances) without requiring a manual unblock

#### Scenario: Post-fix head or diff unavailable falls through to full re-review

- **WHEN** the authoritative post-fix head cannot be carried back, or the delta diff over
  `reviewed-sha...<post-fix-head>` cannot be obtained (e.g. the commit object is not present)
- **THEN** the pipeline SHALL fall through to the conservative full re-review path
- **AND** SHALL NOT reuse the pre-fix diff for the re-review
- **AND** SHALL NOT record a post-fix `reviewed-sha` sentinel over a stale or pre-fix diff

#### Scenario: Re-review remains bounded and rigor-preserving

- **WHEN** the pipeline re-runs the delta review after an auto-fix commit
- **THEN** the re-review SHALL run exactly once (the one-attempt bound is unchanged)
- **AND** the `max_adversarial_rounds` counter SHALL NOT be incremented
- **AND** the re-review SHALL still be able to block on genuinely unresolved or newly
  introduced findings in the post-fix diff

#### Scenario: A stale GitHub-API read at the final approval revalidation does not veto a resolved auto-fix

- **WHEN** the post-fix re-review approves and the pipeline re-reads the PR head from the
  GitHub API to confirm no push landed during the re-review, and that read still echoes the
  known pre-fix head (the head the delta review evaluated before the auto-fix ran)
- **THEN** the pipeline SHALL treat that read as the known GitHub-API staleness, not as
  evidence of a newer concurrent push, and SHALL proceed
- **AND** the pipeline SHALL still re-enter the SHA gate when that read returns a SHA that is
  neither the pre-fix head nor the auto-fix commit SHA (a genuinely newer concurrent push)

### Requirement: Pre-merge auto-fix category matrix SHALL document allowlist membership and rationale

The living `pre-merge-fix-round` capability SHALL document a category matrix that classifies each known finding category as allowlisted or residual-excluded for the pre-merge auto-fix path, with a short rationale. The matrix SHALL include at least: allowlisted `correctness` (mechanical code defect), `missing-dep` (wiring/import omission), and `concurrency` (race/lock/ordering/probe defects fixable surgically without product judgment); and residual-excluded `security` (auth/boundary judgment), `scope` (plan/product boundary), `product-judgment-required` (explicit non-mechanical), `spec-divergence` (separate bounded repair path / human disposition), `data-loss` (irreversible impact risk), `observability` (often product taste when blocking), and any absent/empty/unrecognized token (fail-closed for that finding). The runtime allowlist SHALL match the matrix's allowlisted set. Expanding the allowlist SHALL require updating this matrix, the pure eligibility helpers, and regression tests in the same change. A residual-excluded finding co-batched with allowlisted findings SHALL NOT veto auto-fix of the allowlisted subset; pure residual-only batches still skip the harness.

#### Scenario: matrix matches runtime allowlist

- **WHEN** a reader inspects the living category matrix and the pure eligibility helper
- **THEN** a category marked allowlisted in the matrix SHALL pass `isAutoFixableFinding`
- **AND** a category marked residual-excluded (or absent/unrecognized) SHALL fail `isAutoFixableFinding`

#### Scenario: security remains excluded from allowlist after partition

- **WHEN** the allowlist includes `concurrency`
- **THEN** `security`, `scope`, and `product-judgment-required` SHALL remain excluded from the
  allowlist
- **AND** a pure residual-only blocking set SHALL escalate without auto-fix
- **AND** a mixed allowlisted + residual set SHALL still attempt auto-fix for the allowlisted
  subset only

### Requirement: Allowlisted pre-merge blocking findings SHALL not silent-first-hop to needs-human

The pipeline SHALL invoke the bounded auto-fix path when the pre-merge delta partition yields a non-empty **auto-fixable** subset (findings whose category is in the allowlist), an implementer harness is configured, and no prior auto-fix attempt is recognized for the entry — even when residual non-allowlisted findings are also present. A #668-class concurrency-only (or mixed allowlisted) blocking set SHALL receive one auto-fix attempt and one re-review; a #729-class mixed concurrency + `spec-divergence` set SHALL likewise receive one auto-fix attempt scoped to the allowlisted subset. On success with no remaining blocking findings, pre-merge proceeds; on still-blocking re-review (including residual human-required findings), fix failure, or exhausted prior attempt, the pipeline SHALL escalate to `needs-human` with exhausted-attempt, residual-disposition, or failure evidence — not a silent first-hop skip of auto-fix for a non-empty allowlisted subset.

#### Scenario: concurrency-only block attempts auto-fix once

- **WHEN** the delta review blocks only on `concurrency` findings
- **AND** no prior auto-fix commit exists
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL invoke the auto-fix harness once
- **AND** SHALL re-run the delta review once after a successful fix commit

#### Scenario: mixed concurrency + residual does not silent-first-hop

- **WHEN** the delta review blocks on at least one `concurrency` (or other allowlisted) finding
  and at least one residual non-allowlisted finding
- **AND** no prior auto-fix attempt exists
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL invoke the auto-fix harness once for the allowlisted subset
- **AND** SHALL NOT escalate to `needs-human` on the first hop without that attempt

#### Scenario: exhausted attempt surfaces clear evidence

- **WHEN** a prior pre-merge auto-fix commit is already present among developer commits since the
  reviewed SHA
- **AND** the current delta review still returns blocking findings (allowlisted or residual)
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again
- **AND** the block path SHALL remain distinguishable from a pure residual-only first-hop skip
  (prior auto-fix marker / exhausted attempt, not "no allowlisted subset" alone)

### Requirement: Pre-merge auto-fix clean no-op SHALL re-verify findings against current HEAD

The pipeline SHALL, when a bounded pre-merge auto-fix attempt ends with a confirmed clean
no-commit outcome (`headAfter === headBefore`, worktree clean, nothing salvageable), re-verify every
still-open blocking finding from that delta round against the **current** PR head before any
`needs-human` escalation. Re-verify SHALL be exactly one of: (a) a single delta review re-run over
`last-reviewed-sha...HEAD` at the unchanged head, reusing the post-auto-fix re-review machinery and
ceiling rules (no review-2 budget consumption), or (b) an equivalent deterministic HEAD check that
proves each blocking finding is or is not still true at that head. The re-verify SHALL NOT count as a
second auto-fix attempt and SHALL NOT invoke the implementer harness again for that entry. The
pipeline SHALL record durable evidence of the noop-clean attempt so the one-attempt bound holds on
restart.

#### Scenario: auto-fix no-commit and re-verify clean — pre-merge proceeds

- **WHEN** the bounded auto-fix ends noop-clean
- **AND** the single re-verify reports no blocking findings under the active `review_policy`
  (finding gone, not reproducible, or proven already fixed on HEAD)
- **THEN** the pipeline SHALL return without setting `blocked`/`needs-human`
- **AND** SHALL allow remaining pre-merge gates to continue
- **AND** SHALL record evidence that auto-fix was a no-op because the code already matched the
  recommendation or the delta finding was a false positive
- **AND** SHALL NOT launch a second auto-fix attempt

#### Scenario: auto-fix no-commit and re-verify still broken — needs-human once

- **WHEN** the bounded auto-fix ends noop-clean
- **AND** the single re-verify still reports one or more blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human` exactly once for that entry
- **AND** SHALL NOT invoke the auto-fix harness a second time
- **AND** the block body SHALL follow the no-op still-broken recipe (see block-comment requirement)

#### Scenario: re-verify is not a second fix attempt

- **WHEN** a noop-clean outcome triggers re-verify
- **THEN** the implementer harness SHALL NOT be invoked again for the same pre-merge entry
- **AND** the `max_adversarial_rounds` counter SHALL NOT be incremented by the re-verify

#### Scenario: re-verify unavailable fails closed

- **WHEN** the noop-clean path cannot obtain a re-verify result (reviewer unparseable, head currency
  unknown, or required seams unavailable)
- **THEN** the pipeline SHALL NOT treat the no-op as approval
- **AND** SHALL take the existing conservative re-review or `needs-human` fail-closed path

### Requirement: Pre-merge auto-fix terminal block comments SHALL distinguish no-op outcomes

The pipeline SHALL, when it escalates or discloses after a pre-merge auto-fix attempt, make the
operator-facing block or diagnostic body distinguish these cases:

| Case | Required message contract |
|------|---------------------------|
| Auto-fix noop-clean, re-verify clean | MUST NOT set `blocked`/`needs-human` for the no-op alone; evidence records no-op already-fixed / false-positive |
| Auto-fix noop-clean, re-verify still broken | MUST include that auto-fix made no diff and the finding is still present at a named path (or equivalent explicit human-fix recipe) |
| Auto-fix failed / dirty / timeout / salvage failure | Existing error, salvage, and #553 disclosure contracts apply |

A bare *“no recoverable work”* disclosure alone SHALL NOT be the sole reason to hard-block when
re-verify has not yet run. When re-verify still blocks, the body MAY retain the #553 worktree path
disclosure in addition to the still-broken recipe.

#### Scenario: still-broken no-op block names path and no-diff

- **WHEN** auto-fix ends noop-clean and re-verify still blocks
- **THEN** the `needs-human` comment or block reason SHALL state that auto-fix produced no diff
- **AND** SHALL name that the finding is still present (including a cited path when the finding
  carries one)
- **AND** SHALL NOT claim only that the worktree was clean with no further recipe

#### Scenario: re-verify clean does not leave a blocking no-recoverable-work comment as authority

- **WHEN** auto-fix ends noop-clean and re-verify is clean
- **THEN** the pipeline SHALL NOT leave `pipeline:blocked` set solely for the clean no-op
- **AND** SHALL NOT treat a prior “no recoverable work” diagnostic as blocking authority

### Requirement: Pre-merge clean-noop re-verify SHALL be covered by regression tests

The test suite SHALL cover the pre-merge clean-noop re-verify path using dependency-injection seams
(no real harness, git, or network) and SHALL include at least: (1) noop-clean then re-verify approve
→ pre-merge proceeds, no `setBlocked` for the no-op; (2) noop-clean then re-verify still blocking →
exactly one `needs-human` with the still-broken recipe; (3) second auto-fix is not launched after
noop-clean; (4) a #683-class stale classification finding that is already fixed on HEAD does not
hard-block when re-verify (or the deterministic HEAD check) is clean. Each test SHALL fail (bite) if
the corresponding behavior is removed.

#### Scenario: noop-clean approve path regression bites

- **WHEN** the re-verify branch is removed so a clean no-commit auto-fix falls through to
  `needs-human` without re-verify
- **THEN** the noop-clean → proceed test SHALL fail

#### Scenario: one-attempt after noop-clean regression bites

- **WHEN** the bound ignores durable noop-clean markers and launches a second auto-fix
- **THEN** the no-second-attempt test SHALL fail

#### Scenario: #683-class stale classification does not hard-block when HEAD is already correct

- **WHEN** a fixture models a delta blocking finding that claims incorrect classification on a path
  that at HEAD already implements the recommended control-flow (for example routing an off-ramp to
  `needs-human` rather than inflating `openspec-invalid`)
- **AND** auto-fix ends noop-clean and re-verify (or the deterministic HEAD check) reports clean
- **THEN** the pipeline SHALL proceed without `needs-human` for that finding
- **AND** the test SHALL fail against the pre-change hard-block-on-clean-no-commit behavior

### Requirement: Pre-merge residual human-required findings SHALL surface clear disposition naming

The pipeline SHALL, when it escalates to `blocked`/`needs-human` after a pre-merge delta
blocking round that involved category partition (mixed allowlisted + residual, residual-only,
or residual still present after an auto-fix attempt), include an operator-facing block reason
that names which blocking override keys (or equivalent finding identifiers) and categories
required human disposition versus which were in the auto-fix attempt scope (when an attempt
ran). Pure residual-only skips SHALL be distinguishable from exhausted auto-fix attempts and
from still-broken post-attempt re-delta blocks.

#### Scenario: mixed batch block names residual vs attempted

- **WHEN** a mixed allowlisted + residual batch either exhausts after one auto-fix attempt with
  residual still blocking, or escalates with residual still present after re-delta
- **THEN** the block reason SHALL identify residual human-required keys/categories
- **AND** SHALL identify allowlisted keys/categories that were auto-fix attempted

#### Scenario: pure residual skip names no-attempt

- **WHEN** every blocking finding is residual non-allowlisted and the harness is skipped
- **THEN** the block reason SHALL indicate human disposition is required for those residual
  findings
- **AND** SHALL NOT claim an auto-fix was attempted for that entry

### Requirement: Pre-merge auto-fix SHALL rematerialize a missing managed worktree before implementer work

When pre-merge auto-fix is eligible and the managed worktree is absent, the pipeline SHALL first
reconcile the open PR head and candidate identity and then attempt safe rematerialization through
`ensureManagedWorktree`. Rematerialization and synchronization SHALL occur before the implementer
attempt is claimed, so their failure SHALL not consume the single implementer repair unit. Success
SHALL continue into the same shared auto-fix transaction on the recreated path. Failure SHALL emit
a typed `worktree-missing`, `worktree-capacity`, or `worktree-creation-failed` diagnostic
with exact evidence and enter the controller's bounded preflight recovery. It SHALL not collapse to
a bare error or product needs-human hold. Normal delta auto-fix and residual re-entry SHALL use the
same production closure and reconciliation seam.

#### Scenario: Residual re-entry rematerializes then runs implementer

- **WHEN** residual re-entry auto-fix is eligible, the managed worktree is absent, and safe
  rematerialization succeeds for the current PR head
- **THEN** the pipeline SHALL claim and invoke auto-fix on the recreated path
- **AND** it SHALL not fail solely because the worktree was initially absent

#### Scenario: Missing worktree enters typed recovery only after rematerialize fails

- **WHEN** auto-fix is eligible, the worktree is absent, and safe rematerialization fails
- **THEN** the path SHALL return a typed worktree diagnostic containing the rematerialization error
- **AND** it SHALL not return a bare error or infer human authority

#### Scenario: Rematerialization failure does not consume implementer repair

- **WHEN** rematerialization fails before an implementer attempt is claimed
- **THEN** the implementer repair budget SHALL remain unchanged
- **AND** the worktree recovery policy SHALL account for its own bounded attempt

#### Scenario: Present worktree skips rematerialize and runs auto-fix

- **WHEN** auto-fix is eligible and a managed worktree already exists for the current candidate
- **THEN** the pipeline SHALL not recreate it solely for auto-fix
- **AND** it SHALL continue through clean-tree preflight and the bounded implementer claim

#### Scenario: Normal delta and residual re-entry share rematerialization

- **WHEN** either normal delta auto-fix or residual re-entry needs an absent worktree
- **THEN** both SHALL use the same `ensureManagedWorktree` and current-identity reconciliation seam

#### Scenario: Candidate movement prevents stale rematerialization mutation

- **WHEN** live reconciliation observes that the PR head changed before rematerialization or repair
- **THEN** the old attempt SHALL be superseded before any mutation
- **AND** eligibility SHALL be recomputed against the new head

### Requirement: Pre-merge bounded auto-fix SHALL use the shared harness-round helper

The pre-merge bounded auto-fix path SHALL run its implementer-round skeleton (head capture, invoke,
salvage on dirty no-commit, commit subject amendment / verification, push coordination) through the
shared harness-round helper rather than a private full copy of that skeleton. One-attempt bound,
noop-clean outcome, amend-to-auto-fix-prefix, and post-fix delta re-review SHALL remain
pre-merge product rules and SHALL keep their pre-change outcomes.

#### Scenario: Auto-fix skeleton is shared

- **WHEN** pre-merge launches a bounded auto-fix implementer round
- **THEN** head capture, invoke, and salvage sequencing SHALL go through the shared harness-round helper
- **AND** a successful fix SHALL still be pushed and re-reviewed exactly once under the existing
  one-attempt bound

#### Scenario: Noop-clean outcome is preserved

- **WHEN** the auto-fix harness exits with no new commit and a clean worktree
- **THEN** the path SHALL expose the existing noop-clean outcome for re-verify
- **AND** SHALL NOT create a salvage commit or consume a second auto-fix attempt incorrectly

### Requirement: Pre-merge auto-fix attempt authority SHALL be the stage-attempt ledger

Pre-merge auto-fix SHALL perform at most one implementer attempt per authoritative candidate
identity using the stage-attempt ledger as the sole attempt authority. Trusted pipeline-attested
attempt-started / noop-clean PR comments and auto-fix commit-subject prefixes MAY be written and
hydrated as cross-host attestation inputs into the ledger, but callers SHALL NOT maintain a separate
parallel attempt book based only on sentinel regex scans or commit-subject inference disconnected
from the ledger API. Supervisor repair path identity (item, candidate, evidence fingerprint, action)
remains as already specified; child-stage and supervisor claims SHALL share that identity space.

#### Scenario: Restart honors ledger autofix claim without in-memory state

- **WHEN** a prior process claimed autofix for candidate head `H` via the ledger
- **AND** a new process resumes with empty in-memory flags
- **THEN** the pipeline SHALL NOT invoke the implementer again for that key
- **AND** SHALL reconcile the recorded attempt result before the next disposition

#### Scenario: Attested comment is hydration input not a second book

- **WHEN** an attested autofix-attempt comment exists for head `H`
- **THEN** ledger hydration MAY incorporate that comment as evidence
- **AND** subsequent eligibility checks SHALL go through the ledger API rather than a second
  independent sentinel-only store

