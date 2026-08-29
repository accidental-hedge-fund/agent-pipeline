## MODIFIED Requirements

### Requirement: The pipeline:visual-gate label SHALL be created by init

The legacy `pipeline --init` path and canonical `pipeline init` command SHALL create the `pipeline:visual-gate` label alongside
the other stage labels, and the stage SHALL be represented on an issue by that label through the
normal single-stage-label lifecycle.

#### Scenario: init creates the label

- **WHEN** `pipeline --init` runs against a repo
- **THEN** a `pipeline:visual-gate` label SHALL exist in the repo after the run
