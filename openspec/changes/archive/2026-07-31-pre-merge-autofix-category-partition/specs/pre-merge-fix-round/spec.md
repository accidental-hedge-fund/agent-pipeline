## MODIFIED Requirements

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

## ADDED Requirements

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
