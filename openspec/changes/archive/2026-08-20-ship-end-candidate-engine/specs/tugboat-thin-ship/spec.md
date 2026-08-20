## MODIFIED Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using Pipeline CLI verbs and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate), invoked via the **production-pin** CLI (`$PIPELINE` / the last promoted install)
2. FRG pack: `pipeline factory-release prepare --request <absolute-request.json> --json` in an uncredentialed child, then (when unsigned eligible artifacts exist) `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate credentialed child, re-invoked until pack-done or pack-fail, invoked via the **candidate** engine
3. `pipeline release X.Y.Z` with bare version (no leading `v`) and **without** `--skip-frg` unless the operator escape is active, invoked via the **candidate** engine
4. Wait until the open release PR checks are green
5. `pipeline release finish <pr>`, invoked via the **candidate** engine
6. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
7. `pipeline engine-promote --for X.Y.Z --host <resolved-host>` **without** `--skip-frg` unless the operator escape is active

The composer SHALL NOT implement a second merge policy, grant factory, durable outer ledger, or `pipeline ship` product subcommand as its ship path. The composer SHALL run `gh` and relative path work from the configured ship target repository directory (`REPO_DIR`). After train-complete, Tugboat SHALL NOT keep `$PIPELINE` pointed at the previous production pin for phases 2, 3, and 5. Tugboat SHALL NOT invoke `git tag` or `gh release create`; publication wait remains on the GitHub Release workflow.

#### Scenario: Phase order is fixed for a successful ship

- **WHEN** Tugboat ships milestone `vX.Y.Z` end to end without failure
- **AND** the operator escape is not active
- **THEN** it SHALL execute train → FRG pack → release prepare → CI wait → release finish → publication wait → engine-promote in that order
- **AND** it SHALL NOT skip the FRG pack phase or the CI wait before release finish

#### Scenario: Thinness forbids second ship brain markers

- **WHEN** an automated thinness check inspects the Tugboat source
- **THEN** the source SHALL identify itself as the thin ship composer
- **AND** it SHALL NOT embed grant-factory or `pipeline ship ` product invocation markers as the ship path

#### Scenario: Ship-end phases do not keep the production-pin CLI

- **WHEN** train is complete for version `1.39.5`
- **AND** `$PIPELINE` at process start is the `1.39.4` production pin
- **THEN** Tugboat SHALL invoke factory-release prepare, factory-gate, `pipeline release`, and `release finish` via the candidate engine
- **AND** it SHALL NOT invoke those verbs via the `1.39.4` `$PIPELINE` binary

## ADDED Requirements

### Requirement: Tugboat SHALL resolve the candidate engine after train-complete

After train is complete or resumed complete, Tugboat SHALL resolve the candidate engine as the control checkout at the FRG-bound `integrated_candidate.git_sha` (40-hex from the factory-release request JSON), or as an explicit candidate install of that SHA, before the FRG pack phase. Allowed roots are a clean `REPO_DIR` whose `HEAD` equals that SHA, `$REPO_DIR/.worktrees/ship-candidate-<sha>`, or `PIPELINE_CANDIDATE_ENGINE_ROOT` after the same `HEAD` and porcelain checks. The entrypoint SHALL be `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"` with cwd `REPO_DIR`. Tugboat SHALL invoke subsequent `factory-release prepare`, `factory-gate`, `pipeline release`, and `release finish` through that resolved candidate. If resolution fails or the resolved `commit_sha` does not equal the SHA being released, Tugboat SHALL fail closed and SHALL NOT fall back to the process-start `$PIPELINE` production pin for those verbs. Train checkpoint SHALL remain so a retry does not retrain.

Tugboat MAY keep process-start `$PIPELINE` for train and `engine-promote`. Tugboat SHALL NOT retarget train to the unpromoted candidate.

#### Scenario: Candidate checkout at the FRG-bound SHA is used for release

- **WHEN** train completes and the FRG-bound candidate SHA is `C`
- **AND** a control checkout or candidate install of `C` is resolvable
- **THEN** Tugboat SHALL invoke `pipeline release` through that candidate
- **AND** that invocation's engine `commit_sha` SHALL equal `C`

#### Scenario: Missing candidate engine fails before FRG pack

- **WHEN** train is complete
- **AND** no control checkout or candidate install matches the FRG-bound SHA
- **THEN** Tugboat SHALL fail before `factory-release prepare`
- **AND** it SHALL NOT invoke prepare via the previous production-pin `$PIPELINE`

### Requirement: Tugboat installed-composer parity SHALL bind the candidate SHA

When Tugboat is the installed composer, its content digest SHALL match `examples/supervisor/shell/tugboat.sh` at the candidate SHA, or the ship SHALL exec that repo script from `REPO_DIR`. A doctor or unit check SHALL fail if ship-end still uses a stale `~/.local/bin/pipeline-ship-playbook` that is not a thin launcher to that repo script, or a stale engine whose `commit_sha` does not equal the candidate SHA being released. Absence of an installed Option 1 composer SHALL skip rather than fail hosts that do not use thin ship.

#### Scenario: Stale playbook used for ship-end fails

- **WHEN** installed `pipeline-ship-playbook` is a stale full compose (digest `2afe3c92…`)
- **AND** candidate `tugboat.sh` digest is `9b8063d1…`
- **AND** the ship uses the installed playbook for release or FRG
- **THEN** the check SHALL fail
- **AND** remediation SHALL name refresh from candidate `examples/supervisor/shell/pipeline-ship-playbook.sh` or exec of the repo script from `REPO_DIR`

#### Scenario: Source regression fails if ship-end still hard-codes process-start PIPELINE

- **WHEN** an automated Tugboat composer check inspects the post-train FRG and release invoke sites
- **AND** those sites still use process-start `$PIPELINE` with no candidate-engine resolution
- **THEN** the check SHALL fail
