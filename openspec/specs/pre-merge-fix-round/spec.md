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

The test suite SHALL cover the pre-merge auto-fix path using the existing dependency-injection
seams (no real harness, git, or network). The tests SHALL cover: a blocking all-`correctness`
review that is auto-fixed and then advances; a blocking `product-judgment-required` (or
`security`) review that escalates without an auto-fix; the one-attempt bound after a prior
auto-fix commit; the developer classification of the auto-fix commit; and — driving the
fix-then-re-review path — that the second (post-fix) review invocation receives a diff
**distinct** from the first review invocation and that the re-review is anchored to the
post-fix head (recorded `reviewed-sha` equals the auto-fix commit SHA, not the pre-fix SHA).
Each test SHALL fail (bite) if the corresponding behavior is removed.

#### Scenario: auto-fix regression tests bite

- **WHEN** the eligibility-and-attempt branch is removed so the delta-review block path
  escalates directly to `needs-human`
- **THEN** at least the all-`correctness`-advances test and the one-attempt-bound test SHALL fail

#### Scenario: escalation regression test bites

- **WHEN** the category allowlist is widened to treat `product-judgment-required` as auto-fixable
- **THEN** the escalation test for `product-judgment-required` SHALL fail

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

