## MODIFIED Requirements

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
