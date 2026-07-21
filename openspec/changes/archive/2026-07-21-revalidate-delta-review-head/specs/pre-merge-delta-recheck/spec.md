## ADDED Requirements

### Requirement: Pre-merge SHALL re-validate the reviewed SHA against the branch head before recording a delta verdict

The pipeline SHALL re-read the PR branch head and confirm that the SHA a pre-merge delta review
was run against is still that head before recording the delta verdict — that is, before posting
the delta-review comment carrying the `reviewed-sha` / `verdict-diff-hash` sentinels and any
`pipeline-blocking-keys` marker, and before any `setBlocked` derived from that verdict. This
re-validation SHALL apply to every pre-merge delta verdict
regardless of outcome: approving, advisory-only, and blocking, on both the initial delta review
and the post-auto-fix delta re-review.

When the reviewed SHA is still the head, the verdict SHALL be recorded exactly as it is today.
When the head has moved to a newer developer/fix commit, the verdict SHALL be treated as
superseded (see the superseded-verdict requirement below).

When the branch head cannot be read or the commits since the reviewed SHA cannot be classified,
the pipeline SHALL fail closed: it SHALL NOT record a blocking verdict against the unconfirmed
SHA, and SHALL take the existing conservative re-review path instead.

#### Scenario: Reviewed SHA is still the head — verdict recorded unchanged

- **WHEN** a pre-merge delta review completes and the re-read PR branch head equals the SHA the
  delta review was run against
- **THEN** the pipeline SHALL record the verdict as today, embedding `reviewed-sha` at that SHA,
  the `verdict-diff-hash`, and the `pipeline-blocking-keys` marker for any blocking findings
- **AND** a blocking verdict SHALL block pre-merge exactly as before

#### Scenario: A fix commit lands during the delta review — blocking verdict is not recorded

- **WHEN** a pre-merge delta review returns findings that block under the active `review_policy`
- **AND** the re-read PR branch head is a newer developer/fix commit than the SHA the delta
  review was run against
- **THEN** the pipeline SHALL NOT record a `pipeline-blocking-keys` marker for that verdict
- **AND** SHALL NOT `setBlocked` the issue on that verdict's findings

#### Scenario: Post-auto-fix delta re-review is re-validated the same way

- **WHEN** the bounded pre-merge auto-fix re-review completes
- **AND** the PR branch head has advanced past the auto-fix commit the re-review was run against
- **THEN** the re-review verdict SHALL be treated as superseded under the same rule
- **AND** the existing confirmation of the auto-fix head on the approving path (the PR-head read
  plus the live remote-ref disambiguation) SHALL be preserved

#### Scenario: Head cannot be confirmed — fail closed to conservative re-review

- **WHEN** the PR branch head or the PR commit list cannot be read while re-validating a delta
  verdict
- **THEN** the pipeline SHALL NOT record that verdict as blocking
- **AND** SHALL take the conservative re-review path, leaving the SHA gate to re-enter on the
  next pre-merge entry

---

### Requirement: A superseded delta verdict SHALL be recorded without blocking authority and SHALL trigger a bounded re-review at the head

The pipeline SHALL record a pre-merge delta verdict that re-validation found to be produced
against a superseded SHA as superseded: the posted comment SHALL name both the SHA the review
ran against and the newer head, SHALL NOT claim the head as its reviewed commit, and SHALL carry
no `pipeline-blocking-keys` marker. The pipeline SHALL then re-run the delta review against the
current head.

Re-running SHALL be bounded: the pipeline SHALL make at most a small fixed number of additional
delta-review attempts within one pre-merge entry, and on exceeding that bound SHALL take the
existing conservative re-review path rather than looping or acting on the superseded verdict.
Delta re-runs triggered by supersession SHALL NOT consume a `max_adversarial_rounds` slot.

#### Scenario: Superseded verdict is visible but carries no blocking keys

- **WHEN** a delta verdict is determined to be superseded
- **THEN** the posted comment SHALL identify it as superseded and name both the reviewed SHA and
  the newer head SHA
- **AND** the comment SHALL contain no `pipeline-blocking-keys` marker
- **AND** SHALL NOT record the newer head as its reviewed commit

#### Scenario: Delta review re-runs against the current head

- **WHEN** a delta verdict is superseded by a newer developer/fix commit
- **THEN** the pipeline SHALL re-resolve the branch head and re-run the delta review against it
- **AND** the resulting verdict SHALL itself be re-validated before being recorded

#### Scenario: Continuous pushes — bounded, then conservative fallback

- **WHEN** the delta review is superseded again after the bounded number of re-run attempts
  within a single pre-merge entry
- **THEN** the pipeline SHALL stop re-running the delta review
- **AND** SHALL take the conservative re-review path rather than blocking on any superseded
  verdict

#### Scenario: Supersession re-runs do not consume the adversarial-round ceiling

- **WHEN** a delta review is re-run because its predecessor was superseded
- **THEN** the `max_adversarial_rounds` counter SHALL NOT be incremented

---

### Requirement: Observed superseded-verdict histories SHALL be covered by regression tests

The pipeline SHALL carry regression tests that replay the two observed production histories
through the pre-merge stage's dependency seams, with no real network, git, or subprocess calls.
Each test SHALL assert that the stale verdict does not block and that a delta review is run
against the head. A control test SHALL assert that a verdict recorded at the current head with
unresolved blocking keys still blocks pre-merge.

#### Scenario: #427 history — verdict at fix-1, head at fix-2

- **WHEN** the recorded delta verdict is at fix-1 SHA `6c8a163` with blocking key `0e760c00`
- **AND** the PR branch head is the later fix-2 commit `dba0c95`
- **THEN** the pre-merge stage SHALL run a delta review against `dba0c95`
- **AND** SHALL NOT block pre-merge on key `0e760c00`

#### Scenario: #432 history — verdict at fix-1 with five blocking findings, head at fix-2

- **WHEN** the recorded delta verdict is at fix-1 SHA `f02a973` with five findings blocking
  under the active `review_policy`
- **AND** the PR branch head is the later fix-2 commit `625e304`
- **THEN** the pre-merge stage SHALL run a delta review against `625e304`
- **AND** SHALL NOT block pre-merge on the five stale finding keys

#### Scenario: Control — verdict at the head still blocks

- **WHEN** the recorded delta verdict's reviewed SHA equals the current PR branch head
- **AND** that verdict records blocking keys that are not overridden
- **THEN** the pre-merge stage SHALL block the issue at `pipeline:pre-merge` with `needs-human`
  exactly as before this change
