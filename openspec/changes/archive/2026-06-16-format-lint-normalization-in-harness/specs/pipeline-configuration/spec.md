## ADDED Requirements

### Requirement: Config SHALL accept an optional `format_gate` array

`PartialConfigSchema` SHALL accept an optional `format_gate` key. When present, it SHALL validate as an array of objects, each with the following fields:

- `command` (`string`, required): the shell command to run in the worktree root (e.g. `"cargo fmt"`, `"eslint --fix src/"`).
- `auto_fix` (`boolean`, required): when `true`, the command is expected to mutate files; the pipeline commits any changes and re-runs the command to verify stability. When `false`, the command is check-only; a non-zero exit immediately blocks.

An unknown key under a `format_gate` entry SHALL be rejected by strict schema validation. When `format_gate` is absent or an empty array, behavior is unchanged.

#### Scenario: format_gate accepted with valid entries

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  format_gate:
    - command: cargo fmt
      auto_fix: true
    - command: cargo clippy -D warnings
      auto_fix: false
  ```
- **THEN** `resolveConfig()` SHALL accept it and expose `config.format_gate` as an array of two entries

#### Scenario: format_gate absent — default is empty array

- **WHEN** `.github/pipeline.yml` does not include a `format_gate:` key
- **THEN** the resolved config SHALL have `config.format_gate` equal to `[]`
- **AND** no format gate commands SHALL be run

#### Scenario: format_gate entry missing required field rejected

- **WHEN** `.github/pipeline.yml` sets a `format_gate` entry without the `auto_fix` field
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the missing field

#### Scenario: unknown key in format_gate entry rejected

- **WHEN** `.github/pipeline.yml` sets a `format_gate` entry with an unrecognized key (e.g. `working_dir`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the unknown key
