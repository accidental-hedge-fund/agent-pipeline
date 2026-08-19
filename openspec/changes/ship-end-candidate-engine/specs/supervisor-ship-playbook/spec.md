## ADDED Requirements

### Requirement: Ship playbook ship-end SHALL execute the candidate engine

The documented alternate chain playbook SHALL invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and any composer-invoked tag using the candidate engine after train is complete or resumed complete. The candidate engine SHALL be the control checkout at the FRG-bound SHA, or an explicit candidate install of that SHA. The playbook SHALL NOT keep process-start `$PIPELINE` as the previous production pin for those verbs. Train SHALL remain on the production-pin CLI.

When the installed playbook digest does not match candidate `examples/supervisor/shell/tugboat.sh`, the playbook SHALL fail closed for ship-end **or** the operator path SHALL exec the repo Tugboat script from `REPO_DIR` instead.

#### Scenario: Playbook release uses the candidate CLI

- **WHEN** the ship playbook finishes train for version `1.39.5`
- **AND** process-start `$PIPELINE` is production pin `1.39.4`
- **THEN** the playbook SHALL invoke `pipeline release` via the candidate engine
- **AND** it SHALL NOT invoke release via the `1.39.4` binary

#### Scenario: Stale installed playbook is not an accepted ship-end composer

- **WHEN** `~/.local/bin/pipeline-ship-playbook` digest differs from candidate `tugboat.sh`
- **AND** the ship still uses that installed playbook for FRG or release
- **THEN** doctor or the ship-end identity check SHALL fail
- **AND** remediation SHALL name refresh from the candidate repo script or exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`

### Requirement: Playbook ship-end identity check SHALL share the Tugboat gate

The playbook SHALL be subject to the same doctor or unit check as Tugboat: fail when ship-end `$PIPELINE --version` or playbook digest does not match the candidate SHA being released; skip when the playbook is not installed and not used. Shared pack helpers SHALL stay in sync with Tugboat for candidate-engine resolution after train.

#### Scenario: Playbook helper regression fails if ship-end stays on process-start PIPELINE

- **WHEN** an automated check inspects playbook post-train FRG and release invoke sites
- **AND** those sites still use process-start `$PIPELINE` with no candidate-engine resolution
- **THEN** the check SHALL fail
