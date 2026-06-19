## ADDED Requirements

### Requirement: Config SHALL accept an optional strict `auto_loop` block

`PartialConfigSchema` SHALL accept an optional `auto_loop` block with strict validation. Its fields SHALL be: `enabled` (boolean, default `false`), `max_rounds` (positive integer), `max_wallclock_minutes` (positive integer), and `stages` (array of pipeline stage names drawn from `STAGES`). An unknown sub-key, a wrong type, or a `stages` entry that is not a recognized stage name SHALL cause `resolveConfig()` to throw a parse error identifying the offending key, consistent with the strict-block validation used for other feature blocks. When the block is absent, `auto_loop` SHALL resolve to its `DEFAULT_CONFIG` value (disabled), and the advance loop's behavior SHALL be unchanged.

The `auto_loop` block SHALL NOT provide any key that enables merging, deploying, publishing, disabling a protected/review step, or otherwise weakening a safety floor — it governs only bounded continuation of existing pipeline-owned recovery. The never-auto-merge guarantee remains structural and is not reachable through `auto_loop`.

#### Scenario: valid auto_loop block resolves

- **WHEN** `.github/pipeline.yml` sets `auto_loop:` with `enabled: true`, `max_rounds: 4`, `max_wallclock_minutes: 30`, and `stages: [eval-gate, shipcheck-gate]`
- **THEN** `resolveConfig()` SHALL resolve `cfg.auto_loop` to those values

#### Scenario: auto_loop absent uses disabled default

- **WHEN** `.github/pipeline.yml` has no `auto_loop` block
- **THEN** `cfg.auto_loop` SHALL equal `DEFAULT_CONFIG.auto_loop` with `enabled: false`

#### Scenario: unknown auto_loop sub-key rejected

- **WHEN** `.github/pipeline.yml` sets an unrecognized key under `auto_loop` (e.g. `auto_merge: true` or `max_minutes: 5`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the offending key

#### Scenario: invalid budget value rejected

- **WHEN** `auto_loop.max_rounds` is set to a non-positive or non-integer value
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `max_rounds`

#### Scenario: unknown stage in allowlist rejected

- **WHEN** `auto_loop.stages` contains a value that is not a member of `STAGES`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the invalid stage entry
