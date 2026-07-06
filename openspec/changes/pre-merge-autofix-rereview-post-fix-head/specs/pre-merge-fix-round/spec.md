## ADDED Requirements

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

## MODIFIED Requirements

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
