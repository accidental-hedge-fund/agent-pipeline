# pre-merge-fix-round Specification

## Purpose
TBD - created by archiving change pre-merge-fix-round. Update Purpose after archive.
## Requirements
### Requirement: Pre-merge SHALL gate the auto-fix on a fixed finding-category allowlist

The pipeline SHALL attempt a bounded auto-fix of a blocking pre-merge delta review only when
**every** blocking finding has a `category` in the allowlist `{ correctness, missing-dep }`
(case-insensitive, trimmed). If **any** blocking finding has a category outside the allowlist —
including `security`, `scope`, `product-judgment-required`, `spec-divergence`, an unrecognized
token, or an absent/empty category — the pipeline SHALL skip the auto-fix and escalate directly to
`needs-human`. Eligibility additionally requires that at least one blocking finding exists and that
an implementer harness is configured.

#### Scenario: all blocking findings are correctness — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `correctness` or `missing-dep`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt (see the bounded-attempt
  requirement) rather than escalating to `needs-human`

#### Scenario: a security finding is present — escalate without auto-fix

- **WHEN** the blocking findings include at least one finding with `category` `security`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately

#### Scenario: a product-judgment or scope finding is present — escalate without auto-fix

- **WHEN** the blocking findings include at least one finding with `category`
  `product-judgment-required` or `scope`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately

#### Scenario: an absent or unrecognized category fails closed

- **WHEN** at least one blocking finding has an absent, empty, or unrecognized `category` (any value
  outside `{ correctness, missing-dep }`)
- **THEN** the pipeline SHALL treat the entry as not auto-fixable
- **AND** SHALL set `blocked`/`needs-human` without invoking the auto-fix harness

### Requirement: Pre-merge SHALL perform at most one auto-fix attempt per entry

The pipeline SHALL perform **at most one** auto-fix attempt for a given pre-merge blocking delta
review. After a successful auto-fix commit the pipeline SHALL re-run the delta review exactly once
against the new head; if that re-review still returns blocking findings the pipeline SHALL set
`blocked`/`needs-human` and SHALL NOT attempt a second auto-fix. The bound SHALL be crash-safe: the
auto-fix commit itself SHALL be the durable marker, so a pre-merge poll that re-enters after the fix
commit landed (including after a process restart) recognizes the prior auto-fix commit and escalates
rather than starting a fresh attempt.

#### Scenario: fix resolves the finding — pre-merge proceeds

- **WHEN** the auto-fix attempt commits a fix and the single re-run delta review returns `approve`
  (or all findings fall below the active `review_policy`)
- **THEN** the pipeline SHALL return without blocking (pre-merge proceeds)
- **AND** SHALL NOT attempt a further auto-fix

#### Scenario: fix does not resolve the finding — escalate, no second attempt

- **WHEN** the auto-fix attempt commits a fix but the single re-run delta review still returns
  blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness a second time

#### Scenario: prior auto-fix commit is recognized after a restart

- **WHEN** the developer commits since the last reviewed SHA already include a pre-merge auto-fix
  commit (recognized by its documented subject prefix)
- **AND** the current delta review still returns blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again for this entry

### Requirement: The pre-merge auto-fix SHALL reuse the surgical-fix prompt and roll back on failure

The auto-fix attempt SHALL invoke the implementer harness with the surgical-fix prompt
(`buildFixPrompt`, #235) scoped to the blocking delta-review findings, run from the issue worktree,
so the minimal-diff discipline, the destructive-operation guard, and the pre-commit self-check apply
unchanged. The attempt SHALL require a clean worktree before starting (fail closed otherwise). On any
failure — harness error, a worktree left dirty/uncommitted, or no commit produced — the pipeline
SHALL roll the worktree back to the pre-fix HEAD over a clean tree and escalate to `needs-human`; it
SHALL NOT push a partial fix.

#### Scenario: auto-fix prompt is the surgical-fix prompt

- **WHEN** the pipeline builds the pre-merge auto-fix prompt
- **THEN** it SHALL use `buildFixPrompt` output (not a looser prompt), carrying the minimal-diff
  instruction, the destructive-operation guard, and the pre-commit self-check

#### Scenario: harness failure rolls back and escalates

- **WHEN** the auto-fix harness invocation fails, or leaves the worktree dirty, or produces no commit
- **THEN** the pipeline SHALL restore the pre-fix HEAD over a clean worktree
- **AND** SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT push a partial fix to the PR head

#### Scenario: dirty worktree before the attempt fails closed

- **WHEN** the worktree has uncommitted changes before the auto-fix attempt starts
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL escalate to `needs-human` without mutating git state

### Requirement: The pre-merge auto-fix commit SHALL be developer-classified and traceable

The auto-fix commit SHALL carry the run's `Issue: #N` and `Pipeline-Run: <id>` git trailers and
SHALL be classified as a developer commit, so the review-SHA gate re-reviews it. `isPipelineInternalCommit`
SHALL continue to return `false` for the auto-fix commit subject; the recognizable marker used by the
one-attempt bound (a commit-subject prefix or dedicated trailer) SHALL NOT cause
`isPipelineInternalCommit` to return `true`.

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

The test suite SHALL cover the pre-merge auto-fix path using the existing dependency-injection seams
(no real harness, git, or network). The tests SHALL cover: a blocking all-`correctness` review that
is auto-fixed and then advances; a blocking `product-judgment-required` (or `security`) review that
escalates without an auto-fix; the one-attempt bound after a prior auto-fix commit; and the
developer classification of the auto-fix commit. Each test SHALL fail (bite) if the corresponding
behavior is removed.

#### Scenario: auto-fix regression tests bite

- **WHEN** the eligibility-and-attempt branch is removed so the delta-review block path escalates
  directly to `needs-human`
- **THEN** at least the all-`correctness`-advances test and the one-attempt-bound test SHALL fail

#### Scenario: escalation regression test bites

- **WHEN** the category allowlist is widened to treat `product-judgment-required` as auto-fixable
- **THEN** the escalation test for `product-judgment-required` SHALL fail

