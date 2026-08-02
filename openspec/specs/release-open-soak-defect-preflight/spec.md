# release-open-soak-defect-preflight Specification

## Purpose
TBD - created by archiving change release-block-open-soak-engine-defects. Update Purpose after archive.
## Requirements
### Requirement: Release open-soak-defect preflight SHALL discover candidate-linked open engine-class defects

The pipeline SHALL provide an open-soak-defect preflight that, given a resolved release version and
the candidate's Factory Reliability Gate (FRG) evidence when available, discovers **open**
engine-class soak defects attributable to that candidate. Attribution sources SHALL include, in
priority order: (1) the FRG durable `loop_run_id` and FRG `run_id` when present; (2) durable recovery
ledger terminal evidence and canonical stage diagnostics for that run; (3) open GitHub issues that
reference that soak identity; (4) when present, typed reason/disposition and discovery/candidate
attribution fields (#760 / #763). The preflight SHALL also consider open issues created since the
previous release tag that are engine-class under the classification rules below. The discovery result
SHALL be a structured set of blocking items each carrying at least an issue number when GitHub-backed,
a classification source (`typed` or `label-fallback`), and a short title or reason key.

#### Scenario: Soak run_id links open engine-defect issues

- **WHEN** FRG evidence for the resolved version supplies `loop_run_id` `loop-abc`
- **AND** open issues reference `loop-abc` and represent terminal engine-class soak defects
- **THEN** the preflight result SHALL include those issues as blocking
- **AND** SHALL name classification source `typed` when typed evidence supports the class

#### Scenario: Created-since-previous-tag window is considered

- **WHEN** no issue body embeds the loop id but open engine-class issues were created after the
  previous release tag and are otherwise attributable to the candidate soak window
- **THEN** the preflight SHALL still evaluate them under engine-class classification rules
- **AND** SHALL NOT ignore the entire post-tag window solely because body linkage is missing

#### Scenario: Closed issues never block

- **WHEN** an engine-class soak defect issue is closed
- **THEN** it SHALL NOT appear in the blocking set

---

### Requirement: Engine-class classification SHALL prefer typed terminal evidence over labels

The preflight SHALL classify a soak-linked defect as engine-class when typed evidence indicates a
terminal engine-owned failure or recovery exhaustion projecting to engine-class (including
`workflow-engine-defect` and FRG engine-class taxonomy members) for the candidate run. Canonical
`pipeline/stage-diagnostic@1` reason codes and durable recovery terminal outcomes SHALL be preferred
over issue labels. A typed, candidate-linked engine-class defect SHALL block even when the related
GitHub issue lacks `bug`, lacks `pipeline:engine-class`, or carries a wrong label such as
`enhancement`. Labels SHALL be used only as a fallback for historical records that lack usable typed
evidence: an open issue carrying both `bug` and `pipeline:engine-class` MAY enter the blocking set
under the candidate window rules when typed evidence is unavailable.

#### Scenario: Typed hit blocks despite missing bug label

- **WHEN** typed terminal evidence marks issue `#712` as a candidate-linked engine-class defect
- **AND** `#712` is open and has no `bug` label
- **THEN** the preflight SHALL include `#712` in the blocking set
- **AND** SHALL NOT clear it solely because labels are incomplete

#### Scenario: Label fallback selects historical engine-class issues

- **WHEN** typed evidence is unavailable for an open issue created in the candidate window
- **AND** that issue carries both `bug` and `pipeline:engine-class`
- **THEN** the preflight SHALL include it via classification source `label-fallback`

#### Scenario: Label fallback does not apply without both markers

- **WHEN** typed evidence is unavailable for an open issue
- **AND** the issue has `bug` but not `pipeline:engine-class` (or the reverse)
- **THEN** label-fallback classification SHALL NOT alone add it to the blocking set

---

### Requirement: Converged intermediate blockers SHALL NOT count as open release defects

The preflight SHALL NOT treat a recoverable intermediate blocker that was recovered and did not
remain terminal for the item in the same candidate soak run as an open release defect. Only open
terminal engine-class failures, recovery exhaustion with engine-class disposition, or still-open
issues that represent those terminal outcomes SHALL block release preparation.

#### Scenario: In-run recovery convergence does not block

- **WHEN** an item recorded a recoverable engine-adjacent blocker mid-run
- **AND** recovery succeeded and the item was no longer terminally failed at run end
- **AND** no open issue remains representing a terminal engine-class defect for that fingerprint
- **THEN** the preflight SHALL NOT block release for that intermediate event alone

#### Scenario: Recovery exhaustion remains blocking while open

- **WHEN** recovery for a candidate-linked engine-class defect exhausted its budget
- **AND** the corresponding auto-filed or linked issue is still open
- **THEN** the preflight SHALL include that defect in the blocking set

---

### Requirement: Typed ledger evidence SHALL join open issues only via defect-specific identity

The preflight SHALL require a defect-specific identity when projecting terminal or recovery typed
ledger evidence onto open GitHub issues: an explicit issue number on the evidence, or a matching
evidence fingerprint present on the issue. Category-level fields alone (`blockerClass`, typed
disposition / `Blocker class:` body text) SHALL NOT be sufficient to join evidence to an issue.
Unmatched terminal evidence that names a defect surface (title or reason key) MAY remain a synthetic
unlinked blocker rather than borrowing terminal or recovered state from every soak-linked issue of
the same class.

#### Scenario: Unidentified terminal evidence does not join same-class open issues

- **WHEN** terminal engine-class ledger evidence for the candidate soak has neither `issueNumber`
  nor `fingerprint`
- **AND** open soak-linked issues exist that share only the same blocker class or disposition
- **THEN** the preflight SHALL NOT mark those open issues as typed terminal blockers solely via
  that class match
- **AND** when the evidence carries a title or reason key, it MAY appear as a synthetic unlinked
  typed blocker instead

#### Scenario: Unidentified recovered evidence does not suppress same-class label fallback

- **WHEN** recovered non-terminal ledger evidence has neither `issueNumber` nor `fingerprint`
- **AND** an open soak-linked issue carries `bug` + `pipeline:engine-class` for label fallback
- **THEN** the preflight SHALL NOT suppress that issue's label-fallback classification solely
  because the recovered evidence shares the same blocker class

---

### Requirement: Non-empty open-defect set SHALL fail closed with doctor-grade remediation

When the blocking set is non-empty and no valid audited override is supplied, the preflight SHALL
fail closed (non-zero). The error surface SHALL name the resolved version, the soak identity when
known (`loop_run_id` and/or FRG `run_id`), list each blocking issue (number and title or reason),
state the classification source per item, and give remediation options: fix and close the issues,
re-run soak/FRG after fixes, or pass the audited override with a non-empty reason.

#### Scenario: Open defects produce actionable failure

- **WHEN** the blocking set contains open issues `#712` and `#714`
- **AND** no override is supplied
- **THEN** the preflight SHALL fail
- **AND** the message SHALL list `#712` and `#714` with remediation that mentions override and close/fix paths

#### Scenario: Empty blocking set passes

- **WHEN** discovery finds no open candidate-linked engine-class defects
- **THEN** the preflight SHALL pass without requiring an override

---

### Requirement: Audited override SHALL be the only skip path and SHALL require a non-empty reason

The preflight SHALL accept an explicit override only when the caller supplies a non-empty reason
string via the release CLI override flag defined by `release-sub-command`. Empty, whitespace-only,
or absent override SHALL NOT clear a non-empty blocking set. There SHALL be no silent environment
variable or config default that skips this gate without an explicit per-invocation override reason.
When override is accepted, the preflight result SHALL carry the waived issue numbers and reason for
release PR recording.

#### Scenario: Override with reason permits release preparation past open defects

- **WHEN** the blocking set is non-empty
- **AND** the caller supplies a non-empty override reason
- **THEN** the preflight SHALL not fail closed solely due to those open defects
- **AND** SHALL return waived issue numbers and the reason for PR body attachment

#### Scenario: Empty override reason is rejected

- **WHEN** the blocking set is non-empty
- **AND** the caller supplies an empty or whitespace-only override reason
- **THEN** the preflight SHALL fail closed as if no override was supplied

#### Scenario: Silent skip does not exist

- **WHEN** the blocking set is non-empty and no CLI override reason is provided
- **THEN** the preflight SHALL fail closed
- **AND** SHALL NOT consult a silent config or environment skip flag as sufficient authority

