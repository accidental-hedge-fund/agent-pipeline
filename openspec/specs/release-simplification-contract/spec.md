# release-simplification-contract Specification

## Purpose
TBD - created by archiving change preserve-no-change-tester-candidate. Update Purpose after archive.
## Requirements
### Requirement: Release simplification design SHALL record the approved ordered outcome

The scoped release-simplification design SHALL record this approved order: independently verify the merged milestone work; prepare and merge version metadata before any fake release gate work; freeze the latest `origin/main` candidate as `C`; run exactly two valid fake issues through the unchanged ordinary pipeline until each reaches `pipeline:ready-to-deploy` without merging either pull request; tag `C`; verify GitHub publication; and finish the ship path by invoking release. The design SHALL exclude installation and deployment and SHALL retain optional observability #1482.

#### Scenario: Design records metadata before fake release gates

- **WHEN** the release-simplification design is reviewed
- **THEN** it SHALL place independent merged-milestone verification and preparation and merge of version metadata before freezing candidate `C` and running the two fake issues
- **AND** fake issue work SHALL NOT begin from pre-metadata candidate identity

#### Scenario: Exactly two ordinary pipeline candidates stop without merge

- **WHEN** the design describes fake-issue verification of frozen candidate `C`
- **THEN** it SHALL require exactly two valid fake issues
- **AND** each SHALL use the unchanged ordinary issue-to-ready-to-deploy pipeline
- **AND** each SHALL stop at `pipeline:ready-to-deploy` without merge

#### Scenario: Tag and publication remain bound to frozen candidate C

- **WHEN** both fake issues have produced the required ready-to-deploy evidence
- **THEN** the design SHALL tag frozen candidate `C`
- **AND** SHALL require authoritative verification of the corresponding GitHub publication
- **AND** SHALL finish by invoking release

#### Scenario: Installation and deployment are excluded

- **WHEN** the design defines the end of this release path
- **THEN** it SHALL NOT include installation or deployment
- **AND** optional observability #1482 SHALL remain available rather than becoming mandatory or being removed

### Requirement: Release simplification SHALL remain divided into five independently delivered packages

The design SHALL identify this change as package 2 of 5, owning the exact-candidate two-issue FRG runner/observer, replacement of its release-path prepare/score/attest/re-observe dependencies, migration of genuine qualification regressions to normal CI, and the trusted-candidate dirty-inventory correction. Package 1 SHALL remain the delivered no-change Tester and template-validation prerequisite. Package 3 SHALL own complete release/ship integration, package 4 SHALL own dependency-checked retirement of remaining obsolete callers, and package 5 SHALL own migration to the simplified path. Later-package release execution and remaining-caller retirement SHALL NOT become package-2 completion tasks.

#### Scenario: Package two completion is independently checkable

- **WHEN** implementers evaluate package 2 completion
- **THEN** they SHALL evaluate the exact-pair runner/observer, result verification, release-path dependency replacement, regression migration, dirty-inventory correction, generated-artifact freshness, and repository verification gates
- **AND** SHALL NOT require a live synthetic run, release action, version bump, fixture merge, tag, publication, promotion, installation, or deployment

#### Scenario: Package one completion is independently checkable

- **WHEN** package 1 is evaluated after package 2 is specified
- **THEN** package 1 SHALL remain complete from its no-change Tester correction, deterministic template validation, scoped design artifacts, generated-artifact freshness, and repository verification gates
- **AND** package 2 SHALL NOT retroactively add live fixture or release work to package 1

#### Scenario: Four later packages remain explicit future work

- **WHEN** the five-package plan is read
- **THEN** package 1 SHALL remain the prerequisite template and Tester correction
- **AND** packages 3 through 5 SHALL respectively retain complete release/ship integration, remaining obsolete-caller retirement, and simplified-path migration
- **AND** the package-2 runner SHALL remain independently deliverable without claiming that packages 3 through 5 are implemented

#### Scenario: Proven candidate remains the later tag target

- **WHEN** package 2 records a proven candidate `C`
- **THEN** the approved release contract SHALL require later release metadata to have preceded that proof and the eventual tag target to equal `C`
- **AND** publication verification and ship completion through release SHALL remain owned by later release phases

#### Scenario: Review rigor remains unchanged

- **WHEN** package 2 or a later package is implemented
- **THEN** normal independent review and GitHub CI SHALL remain required
- **AND** model defaults and ordinary review policy SHALL NOT be reduced by the simplification

