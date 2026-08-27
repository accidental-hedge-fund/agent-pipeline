## ADDED Requirements

### Requirement: Init SHALL scaffold both harness roles as active required keys

When `init` writes a new `.github/pipeline.yml`, the file SHALL contain active (non-commented) `harnesses.implementer` and `harnesses.reviewer` keys, each a non-empty harness name. The scaffold comments for those keys SHALL identify them as required repository execution policy. The comments SHALL NOT state that an omitted role falls back to the active profile. Init MAY copy the active profile pair as the starter values written into the new file. After that write, those values are repository policy. Init SHALL NOT invoke the implementer or reviewer harness.

#### Scenario: Fresh scaffold declares both live roles

- **WHEN** `init` is run and `.github/pipeline.yml` is absent
- **THEN** the written file SHALL contain active `harnesses.implementer` and `harnesses.reviewer` keys
- **AND** each value SHALL be a non-empty string

#### Scenario: Scaffold comments do not document profile fallback for live roles

- **WHEN** `init` scaffolds `.github/pipeline.yml`
- **THEN** the `harnesses` comments SHALL NOT say that an omitted role falls back to the active profile

#### Scenario: Init still succeeds when the file is absent

- **WHEN** `pipeline init` runs in a repository with no `.github/pipeline.yml`
- **THEN** the command SHALL NOT fail solely because harness roles were undeclared at start
- **AND** it SHALL write the file and continue to ensure labels
