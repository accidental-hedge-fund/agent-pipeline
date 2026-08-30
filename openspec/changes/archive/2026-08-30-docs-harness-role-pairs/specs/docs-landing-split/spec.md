## MODIFIED Requirements

### Requirement: README SHALL describe the implementer/reviewer pair instead of both CLIs required

The lean README purpose and prerequisites text SHALL describe a runnable repository as declaring an implementer/reviewer pair in `.github/pipeline.yml`. That text SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product. The README SHALL point to the `docs/concepts.md` role matrix for pair examples and `steps.adversarial_review`. The README SHALL NOT embed that full matrix.

#### Scenario: Prerequisites use pair language

- **WHEN** a first-time reader follows only the README prerequisites
- **THEN** they SHALL see an implementer/reviewer pair as repository policy
- **AND** they SHALL NOT be told that both Claude and Codex CLIs are required as the product

#### Scenario: README points at the concepts matrix without embedding it

- **WHEN** a reader wants the harness-pair matrix
- **THEN** the README SHALL contain a working relative link to the `docs/concepts.md` role-matrix section
- **AND** the README body SHALL NOT reproduce the full matrix table
