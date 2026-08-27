## ADDED Requirements

### Requirement: Config validate SHALL treat missing or partial harness roles as errors

`pipeline config validate` SHALL report an error diagnostic when `.github/pipeline.yml` is absent (already required), when the `harnesses` block is absent, or when either `harnesses.implementer` or `harnesses.reviewer` is absent. Each such diagnostic SHALL have `severity: "error"` and SHALL name the missing file or key. The message SHALL state that the active profile does not select live workers. The command SHALL exit 1. A complete `harnesses` pair SHALL not produce this class of diagnostic.

#### Scenario: missing harnesses block is an error

- **WHEN** `.github/pipeline.yml` exists with no `harnesses:` block
- **AND** the user runs `pipeline config validate --json`
- **THEN** the command SHALL print `"valid": false`
- **AND** `diagnostics` SHALL contain an error naming `harnesses.implementer` and `harnesses.reviewer`
- **AND** the command SHALL exit 1

#### Scenario: missing implementer is an error

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `reviewer: codex`
- **AND** the user runs `pipeline config validate --json`
- **THEN** `diagnostics` SHALL contain an error naming `harnesses.implementer`
- **AND** the command SHALL exit 1

#### Scenario: missing reviewer is an error

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **AND** the user runs `pipeline config validate --json`
- **THEN** `diagnostics` SHALL contain an error naming `harnesses.reviewer`
- **AND** the command SHALL exit 1

#### Scenario: complete pair is valid

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and otherwise passes schema validation
- **THEN** `pipeline config validate --json` SHALL print `"valid": true` for this class of diagnostic
- **AND** the command SHALL exit 0 when no other errors exist
