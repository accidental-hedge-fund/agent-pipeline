## MODIFIED Requirements

### Requirement: Operator phrase and status surface SHALL be documented

Operator-facing supervisor documentation and the Hermes skill map SHALL document:

- Phrase `Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z` (detach if the CLI is blocking)
- Default in-engine ship sequence is train `--merge` → FRG pack → release (no `--skip-frg`) → finish → promote
- `--skip-frg` (or the documented env) is an operator escape with a logged reason, not the default
- Status via `pipeline ship status --milestone vX.Y.Z` (JSON) and the Pipeline ship ledger
- Tugboat `--status` / `ship-vX.Y.Z/` is not the product status surface
- Required env for any leftover thin detach wrapper: at least `REPO_DIR`, `PIPELINE`, and merge-capable operator invocation

The documentation SHALL NOT present Tugboat as the product owner. The documentation SHALL NOT be readable as “never in-engine ship.”

#### Scenario: Hermes skill maps ship phrase to Tugboat

- **WHEN** an operator sends `Ship milestone vX.Y.Z` (or the skill’s documented equivalent) on the private factory channel
- **THEN** the skill documentation SHALL direct the host to exec `pipeline ship --milestone vX.Y.Z`
- **AND** if a leftover Tugboat binary is present, it SHALL be a thin detach/notify adapter only
- **AND** status lookup SHALL use `pipeline ship status` / the Pipeline ship ledger

#### Scenario: Hermes skill default is FRG pack then release

- **WHEN** an operator reads the Hermes `pipeline-supervisor` skill or the ship-milestone runbook after this change
- **THEN** the documented default SHALL be FRG pack then release without `--skip-frg`
- **AND** skip SHALL be documented as an operator escape with a logged reason only
- **AND** the text SHALL NOT say FRG is optional or advisory on the ship path

#### Scenario: Status reads state without starting a new ship

- **WHEN** the operator runs `pipeline ship status --milestone vX.Y.Z`
- **THEN** the command SHALL print the existing ship record (or a none/empty status when no record exists)
- **AND** it SHALL NOT start train/FRG pack/release/promote as a side effect of status

## ADDED Requirements

### Requirement: Tugboat SHALL NOT be the in-engine ship product owner

Closed #1001 Option 1 (Tugboat composer) and open #971 (install pack of those wrappers) SHALL NOT be readable as a ban on in-engine `pipeline ship`. Tugboat MAY remain a thin notify or detach adapter that execs `pipeline ship --milestone` or reads `pipeline ship status`. Tugboat SHALL NOT own merge order, terminal classification, recovery, or a second ship ledger. Automated thinness checks SHALL fail if skills or operator docs present Tugboat as the product owner or say in-engine ship is forbidden. Those checks SHALL NOT fail solely because a skill or runbook contains `pipeline ship --milestone`.

#### Scenario: Doctrine cannot be read as never in-engine ship

- **WHEN** an operator reads the ship-milestone runbook, supervisor README, or Hermes skill after this change
- **THEN** the primary ship path SHALL be `pipeline ship --milestone vX.Y.Z`
- **AND** the text SHALL NOT say the product path is Tugboat instead of in-engine ship
- **AND** the text SHALL NOT say in-engine `pipeline ship` is parked or forbidden

#### Scenario: Thinness check allows the product CLI in skills

- **WHEN** an automated thinness check inspects host skills and the ship runbook
- **THEN** it SHALL accept `pipeline ship --milestone` as the product invocation
- **AND** it SHALL fail if those documents name Tugboat as the owner of merge order or recovery
