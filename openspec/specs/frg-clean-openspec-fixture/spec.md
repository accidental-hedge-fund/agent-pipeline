# frg-clean-openspec-fixture Specification

## Purpose
TBD - created by archiving change frg-pack-1401-pipeline-ship-1-40-1-clean-openspec. Update Purpose after archive.
## Requirements
### Requirement: The clean OpenSpec fixture SHALL prove release 1.40.1 through the normal unmerged Pipeline lifecycle

The `pack-1401-pipeline-ship-1.40.1` clean OpenSpec fixture SHALL declare `release_version` exactly `1.40.1`, and its executable test MUST fail when that literal value changes. The fixture SHALL proceed through normal issue-readiness admission, planning, plan review, implementation, review, issue-owned OpenSpec archival, and `pipeline:ready-to-deploy` without reduced rigor, merge, or deployment. After the FRG records the run, the FRG controller SHALL close the pull request and issue without merge. Controller-owned lifecycle observations SHALL remain acceptance evidence and MUST NOT be treated as implementer tasks that can be completed before those events occur.

#### Scenario: Literal release value is accepted

- **WHEN** the executable clean OpenSpec test reads the run-scoped fixture
- **AND** the parsed `release_version` is exactly `1.40.1`
- **THEN** the release assertion SHALL pass

#### Scenario: Changed release value fails

- **WHEN** the fixture's `release_version` differs from `1.40.1`
- **THEN** the executable clean OpenSpec test SHALL fail

#### Scenario: Normal review rigor is observed

- **WHEN** the controller records the clean OpenSpec run lifecycle
- **THEN** the evidence SHALL include issue-readiness admission, planning, plan review, implementation, and review
- **AND** the fixture SHALL have no label-only bypass or reduced-rigor path

#### Scenario: Pre-merge archives only the issue-owned change

- **WHEN** pre-merge processes the clean OpenSpec run
- **THEN** it SHALL archive this issue's OpenSpec change
- **AND** it SHALL leave no foreign active change

#### Scenario: Advance stops ready without merge or deployment

- **WHEN** the full Pipeline completes the clean OpenSpec run
- **THEN** the issue SHALL reach `pipeline:ready-to-deploy`
- **AND** advance SHALL NOT merge or deploy

#### Scenario: Controller closes the recorded synthetic run without merge

- **WHEN** the FRG has recorded the completed run
- **THEN** the FRG controller SHALL close the pull request and issue without merge

