## RENAMED Requirements

- FROM: ### Requirement: The conventions / lessons convention SHALL be described in user-facing documentation
- TO: ### Requirement: The conventions / lessons convention SHALL be described in durable user-facing documentation

## MODIFIED Requirements

### Requirement: The conventions / lessons convention SHALL be described in durable user-facing documentation

The agent-pipeline README and/or linked durable operator documentation SHALL
explain that Pipeline reads the conventions file into every stage prompt, that
maintainers MAY add a lessons/gotchas section to carry recurring patterns, and
that Pipeline never writes the file. Generated short host one-pagers MAY link to
that documentation; they SHALL NOT be required to copy the conventions and
lessons tutorial.

#### Scenario: Documentation describes the lessons convention

- **WHEN** a user follows the generated one-pager's documentation links or reads
  the README conventions guidance
- **THEN** they SHALL find an explanation of conventions-file injection
- **AND** an explicit note that the file is read-only from Pipeline's perspective
- **AND** guidance that a lessons/gotchas section is a supported carry-forward
  pattern

#### Scenario: Generated one-pager does not duplicate the tutorial

- **WHEN** a generated host one-pager is inspected
- **THEN** it MAY point to the durable conventions documentation
- **AND** it SHALL NOT be required to contain a conventions-file or lessons essay
