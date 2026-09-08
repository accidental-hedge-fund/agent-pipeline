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

The design SHALL identify this change as package 1 of 5, owning only the shared no-change Tester candidate correction, deterministic validation of the two existing fake-issue templates, and the scoped design contract. It SHALL identify four later packages for the new FRG runner, the complete release command, retirement of superseded release surfaces, and migration to the simplified path. Later-package behavior and controller/release execution SHALL remain future scope and SHALL NOT become package-1 implementation completion tasks.

#### Scenario: Package one completion is independently checkable

- **WHEN** implementers evaluate package 1 completion
- **THEN** they SHALL evaluate only the no-change candidate behavior, deterministic template validation, scoped design artifacts, generated-artifact freshness, and repository verification gates
- **AND** SHALL NOT require a new FRG execution, live release action, version bump, tag, publication, installation, or deployment

#### Scenario: Four later packages remain explicit future work

- **WHEN** the five-package split is read
- **THEN** packages 2 through 5 SHALL respectively retain ownership of the new FRG runner, complete release command, retirement, and migration
- **AND** describing those packages SHALL NOT claim their implementation is complete

#### Scenario: Review rigor remains unchanged

- **WHEN** package 1 is implemented or later packages use this design
- **THEN** normal independent review and GitHub CI SHALL remain required
- **AND** model defaults and review policy SHALL NOT be reduced by the simplification

