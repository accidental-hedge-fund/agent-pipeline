## MODIFIED Requirements

### Requirement: Ship playbook SHALL be a thin launcher that inherits Tugboat ship-end

The documented alternate chain playbook SHALL exec `$REPO_DIR/examples/supervisor/shell/tugboat.sh` and SHALL NOT retain a second ship-end compose implementation. After that exec, Tugboat SHALL invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and `release ensure-tag` using the candidate engine after train is complete or resumed complete. Tugboat SHALL NOT invoke `git tag` or `gh release create`. Train SHALL remain on the production-pin CLI.

When the installed playbook is selected for ship-end and is not that launcher, doctor or the ship-end identity check SHALL fail closed.

#### Scenario: Playbook release uses the candidate CLI

- **WHEN** the ship playbook finishes train for version `1.39.5`
- **AND** process-start `$PIPELINE` is production pin `1.39.4`
- **THEN** the playbook SHALL have exec'd repo Tugboat
- **AND** Tugboat SHALL invoke `pipeline release` via the candidate engine
- **AND** it SHALL NOT invoke release via the `1.39.4` binary

#### Scenario: Stale installed playbook is not an accepted ship-end composer

- **WHEN** `~/.local/bin/pipeline-ship-playbook` is a full stale compose (not a launcher to repo `tugboat.sh`)
- **AND** the ship still uses that installed playbook for FRG or release
- **THEN** doctor or the ship-end identity check SHALL fail
- **AND** remediation SHALL name refresh from the candidate launcher or exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`

#### Scenario: Inherited Tugboat path includes ensure-tag

- **WHEN** the playbook execs repo Tugboat for a ship that has merged the release PR
- **THEN** that Tugboat path SHALL invoke candidate `release ensure-tag` before `wait-release`
- **AND** the playbook SHALL NOT keep a second compose that waits for GitHub Release without that invoke
