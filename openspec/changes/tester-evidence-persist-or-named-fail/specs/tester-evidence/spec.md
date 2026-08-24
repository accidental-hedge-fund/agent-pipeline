## ADDED Requirements

### Requirement: Successful producer SHALL persist SHA-matched Tester evidence or fail_closed SHALL name the persist/acquire cause

The pipeline SHALL write a SHA-matched `tester-evidence.json` for the candidate HEAD into the current run directory, **or** withhold review with a named persist/acquire reason, when the code-review path invokes the deterministic Tester producer because `on_missing` is `fail_closed` and trustworthy SHA-matched evidence is missing, stale, or malformed, and that producer records a required test-gate command exit 0. The named reason SHALL NOT be the generic missing-file string (`No Tester suite evidence file for this run (missing tester-evidence.json)`). A present trusted-surface decision with `outcome: blocked`, `repo_policy` `failure_reason: missing_base_sha`, and/or all-zero `candidate_sha` SHALL NOT be the sole cause of both (a) no suite artifact and (b) that generic missing-file withhold. Acquisition after the producer attempt SHALL remain load-only and SHALL NOT invent a suite pass. Readiness `evidence_subject` emission MAY stay fail-closed when trusted-surface is blocked; omitting the subject SHALL NOT omit the suite artifact after a recorded exit 0.

#### Scenario: successful producer persists SHA-matched artifact

- **WHEN** review re-entry finds no trustworthy SHA-matched `tester-evidence.json` under `fail_closed`
- **AND** the deterministic producer runs once and records a required test-gate command exit 0
- **AND** the candidate HEAD is a full 40-character SHA
- **AND** a run directory is available
- **THEN** the run directory SHALL contain a SHA-matched `tester-evidence.json` for that HEAD
- **AND** acquisition SHALL treat that artifact as current (subject to existing SHA-match rules)
- **AND** review SHALL NOT withhold the model invoke solely because the file was missing before the producer ran

#### Scenario: persist failure after exit 0 uses a named withhold

- **WHEN** the deterministic producer records a required test-gate command exit 0
- **AND** no SHA-matched `tester-evidence.json` exists after that attempt
- **THEN** `fail_closed` SHALL withhold with a named persist/acquire reason other than the generic missing-file string
- **AND** that reason SHALL name the persist/acquire cause (for example trusted-surface blocked, `missing_base_sha`, or persist write failure)
- **AND** acquisition SHALL NOT invent a suite pass

#### Scenario: trusted-surface missing_base_sha is not generic missing

- **WHEN** the run directory contains `trusted-surface.json` with `outcome: blocked`
- **AND** `repo_policy` `failure_reason` is `missing_base_sha`
- **AND** trusted-surface `candidate_sha` is all zeros
- **AND** the producer recorded a required test-gate command exit 0
- **THEN** review SHALL NOT withhold using only the generic missing-file string
- **AND** either SHA-matched Tester evidence SHALL be present for the real candidate HEAD or the withhold reason SHALL name the trusted-surface / persist cause

#### Scenario: producer that did not record exit 0 may still withhold as missing

- **WHEN** the optional producer is not invoked, throws before recording a command result, or records a non-zero test-gate exit
- **AND** no trustworthy SHA-matched artifact exists
- **AND** `on_missing` is `fail_closed`
- **THEN** acquisition MAY still withhold
- **AND** SHALL NOT claim that tests passed

### Requirement: Persist-or-named-fail regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a producer callback resolves after recording test-gate exit 0 and review still withholds solely because `tester-evidence.json` is missing; (2) a `trusted-surface.json` `repo_policy` `missing_base_sha` with all-zero `candidate_sha` is collapsed into the generic missing-file withhold string with no distinct diagnostic.

#### Scenario: missing-file withhold after recorded exit 0 fails the suite

- **WHEN** a unit test drives review Tester acquisition with a producer that records test-gate exit 0 and does not leave a SHA-matched artifact under the generic missing classification
- **THEN** the test SHALL fail unless withhold is false because a SHA-matched artifact was written, or withhold is true with a named persist/acquire reason other than the generic missing-file string

#### Scenario: missing_base_sha collapse fails the suite

- **WHEN** a unit test supplies `trusted-surface.json` with `outcome: blocked`, `repo_policy` `missing_base_sha`, and all-zero `candidate_sha` after a producer that recorded test-gate exit 0
- **THEN** the test SHALL fail if the withhold reason is only the generic missing-file string
