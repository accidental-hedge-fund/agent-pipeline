## MODIFIED Requirements

### Requirement: Config validate SHALL treat missing or partial harness roles as errors

`pipeline config validate` SHALL report an error diagnostic when `.github/pipeline.yml` is absent (already required), when the `harnesses` block is absent, or when either `harnesses.implementer` or `harnesses.reviewer` is absent. Each such diagnostic SHALL have `severity: "error"` and SHALL name the missing file or key. The message SHALL state that the active profile does not select live workers. A missing-file diagnostic SHALL name `pipeline init`. A missing-role diagnostic SHALL name `pipeline config sync`. The command SHALL exit 1. A complete `harnesses` pair SHALL not produce this class of diagnostic.

#### Scenario: missing harnesses block is an error

- **WHEN** `.github/pipeline.yml` exists with no `harnesses:` block
- **AND** the user runs `pipeline config validate --json`
- **THEN** the command SHALL print `"valid": false`
- **AND** `diagnostics` SHALL contain an error naming `harnesses.implementer` and `harnesses.reviewer`
- **AND** that diagnostic SHALL name `pipeline config sync`
- **AND** the command SHALL exit 1

#### Scenario: missing implementer is an error

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `reviewer: codex`
- **AND** the user runs `pipeline config validate --json`
- **THEN** `diagnostics` SHALL contain an error naming `harnesses.implementer`
- **AND** that diagnostic SHALL name `pipeline config sync`
- **AND** the command SHALL exit 1

#### Scenario: missing reviewer is an error

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **AND** the user runs `pipeline config validate --json`
- **THEN** `diagnostics` SHALL contain an error naming `harnesses.reviewer`
- **AND** that diagnostic SHALL name `pipeline config sync`
- **AND** the command SHALL exit 1

#### Scenario: complete pair is valid

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and otherwise passes schema validation
- **THEN** `pipeline config validate --json` SHALL print `"valid": true` for this class of diagnostic
- **AND** the command SHALL exit 0 when no other errors exist

### Requirement: `pipeline config sync` previews or applies a safe config refresh

The `pipeline config sync [--repo-path <path>] [--apply]` command SHALL refresh an existing `.github/pipeline.yml` using the current config scaffold contract. Without `--apply`, it SHALL run in preview mode and perform no writes. With `--apply`, it SHALL write the refreshed file only after validation succeeds. When the existing file's only error diagnostics are omitted required harness roles, `pipeline config sync` SHALL proceed into harness-role inference as specified by `config-sync-harness-inference` rather than blocking. Any other error diagnostic SHALL still block sync.

#### Scenario: Sync preview exits successfully for valid drift

- **WHEN** the user runs `pipeline config sync` on a valid config that differs from the current scaffold structure
- **THEN** the command SHALL print a human-readable preview of the proposed change
- **AND** the command SHALL exit 0
- **AND** the config file SHALL remain unchanged

#### Scenario: Sync apply writes refreshed config

- **WHEN** the user runs `pipeline config sync --apply` on a valid, safely syncable config
- **THEN** the command SHALL write the refreshed config file
- **AND** it SHALL print a success message naming the updated config file
- **AND** it SHALL exit 0

#### Scenario: Sync fails on missing config

- **WHEN** the user runs `pipeline config sync` in a repository with no `.github/pipeline.yml`
- **THEN** the command SHALL print a clear error directing the user to run `pipeline init`
- **AND** it SHALL exit non-zero

#### Scenario: Sync supports repo-path

- **WHEN** the user runs `pipeline config sync --repo-path <path>`
- **THEN** the command SHALL operate on the `.github/pipeline.yml` at the resolved git root for `<path>`

#### Scenario: Sync proceeds on omitted harness roles only

- **WHEN** the user runs `pipeline config sync` on a file whose only error diagnostics are omitted `harnesses.implementer` and/or `harnesses.reviewer`
- **THEN** the command SHALL NOT block solely because those roles are omitted
- **AND** it SHALL run inference as specified by `config-sync-harness-inference`
