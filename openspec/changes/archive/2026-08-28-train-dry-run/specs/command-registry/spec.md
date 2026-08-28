## ADDED Requirements

### Requirement: The train registry flag allowlist SHALL include dryRun and the handler SHALL accept it

The `train` command registry entry SHALL include `dryRun` in `allowedFlags`. After flag validation succeeds, the train handler SHALL accept `--dry-run` and SHALL produce the read-only plan defined by `train-dry-run`. The handler SHALL NOT exit with a "not supported" error for an allowlisted `--dry-run`. Documentation metadata usage for `train` SHALL list `--dry-run` alongside `--merge` and `--json`.

#### Scenario: Allowlisted dry-run is not rejected after validation

- **WHEN** an operator runs `pipeline train --issues 10 --dry-run`
- **THEN** flag validation SHALL accept `dryRun`
- **AND** the handler SHALL NOT exit 2 with `pipeline train: --dry-run is not supported for train; omit it.`

#### Scenario: Train usage names dry-run

- **WHEN** the generated CLI reference for `train` is produced
- **THEN** the usage synopsis SHALL include `--dry-run`

#### Scenario: Handler/allowlist drift fails the suite

- **WHEN** a unit test invokes train with `--dry-run` while `allowedFlags` contains `dryRun`
- **THEN** the test SHALL fail if the handler still rejects the flag as unsupported
