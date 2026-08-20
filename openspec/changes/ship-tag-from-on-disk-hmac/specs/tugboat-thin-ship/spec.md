## MODIFIED Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using Pipeline CLI verbs and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate), invoked via the **production-pin** CLI (`$PIPELINE` / the last promoted install)
2. FRG pack: `pipeline factory-release prepare --request <absolute-request.json> --json` in an uncredentialed child, then (when unsigned eligible artifacts exist) `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate credentialed child, re-invoked until pack-done or pack-fail, invoked via the **candidate** engine
3. `pipeline release X.Y.Z` with bare version (no leading `v`) and **without** `--skip-frg` unless the operator escape is active, invoked via the **candidate** engine
4. Wait until the open release PR checks are green
5. `pipeline release finish <pr>`, invoked via the **candidate** engine
6. `pipeline release ensure-tag <X.Y.Z> <peeled-merge-oid>`, invoked via the **candidate** engine, using `mergeCommitOid` from finish JSON
7. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
8. `pipeline engine-promote --for X.Y.Z --host <resolved-host>` **without** `--skip-frg` unless the operator escape is active

The composer SHALL NOT implement a second merge policy, grant factory, durable outer ledger, or `pipeline ship` product subcommand as its ship path. The composer SHALL run `gh` and relative path work from the configured ship target repository directory (`REPO_DIR`). After train-complete, Tugboat SHALL NOT keep `$PIPELINE` pointed at the previous production pin for phases 2, 3, 5, and 6. Tugboat SHALL NOT invoke `git tag` or `gh release create`; tag create SHALL be candidate `release ensure-tag`; publication wait remains on the GitHub Release workflow.

#### Scenario: Phase order is fixed for a successful ship

- **WHEN** Tugboat ships milestone `vX.Y.Z` end to end without failure
- **AND** the operator escape is not active
- **THEN** it SHALL execute train → FRG pack → release prepare → CI wait → release finish → release ensure-tag → publication wait → engine-promote in that order
- **AND** it SHALL NOT skip the FRG pack phase, the CI wait before release finish, or ensure-tag before publication wait

#### Scenario: Thinness forbids second ship brain markers

- **WHEN** an automated thinness check inspects the Tugboat source
- **THEN** the source SHALL identify itself as the thin ship composer
- **AND** it SHALL NOT embed grant-factory or `pipeline ship ` product invocation markers as the ship path

#### Scenario: Ship-end phases do not keep the production-pin CLI

- **WHEN** train is complete for version `1.39.5`
- **AND** `$PIPELINE` at process start is the `1.39.4` production pin
- **THEN** Tugboat SHALL invoke factory-release prepare, factory-gate, `pipeline release`, `release finish`, and `release ensure-tag` via the candidate engine
- **AND** it SHALL NOT invoke those verbs via the `1.39.4` `$PIPELINE` binary

### Requirement: Tugboat SHALL resolve the candidate engine after train-complete

After train is complete or resumed complete, Tugboat SHALL resolve the candidate engine as the control checkout at the FRG-bound `integrated_candidate.git_sha` (40-hex from the factory-release request JSON), or as an explicit candidate install of that SHA, before the FRG pack phase. Allowed roots are a clean `REPO_DIR` whose `HEAD` equals that SHA, `$REPO_DIR/.worktrees/ship-candidate-<sha>`, or `PIPELINE_CANDIDATE_ENGINE_ROOT` after the same `HEAD` and porcelain checks. The entrypoint SHALL be `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"` with cwd `REPO_DIR`. Tugboat SHALL invoke subsequent `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and `release ensure-tag` through that resolved candidate. If resolution fails or the resolved `commit_sha` does not equal the SHA being released, Tugboat SHALL fail closed and SHALL NOT fall back to the process-start `$PIPELINE` production pin for those verbs. Train checkpoint SHALL remain so a retry does not retrain.

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

## ADDED Requirements

### Requirement: Tugboat SHALL invoke candidate release ensure-tag before wait-release

After `pipeline release finish` returns success, Tugboat SHALL read `mergeCommitOid` from the finish JSON capture. If that field is missing or is not a 40-hex OID, Tugboat SHALL fail closed and SHALL NOT enter `wait-release`. Otherwise Tugboat SHALL invoke candidate `pipeline release ensure-tag <X.Y.Z> <mergeCommitOid>` and SHALL treat a non-zero exit as a failed ship. Tugboat SHALL then poll `gh release view vX.Y.Z` as today. Tugboat SHALL NOT skip ensure-tag because auto-tag-release is configured. Tugboat SHALL NOT skip ensure-tag because the git tree has no `latest.json`.

#### Scenario: Finish JSON merge commit drives ensure-tag

- **WHEN** `pipeline release finish` writes `mergeCommitOid` `M` for version `1.39.5`
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** Tugboat SHALL invoke `"${SHIP_END_CLI[@]}" release ensure-tag 1.39.5 M` (or the same argv through the recorded candidate CLI)
- **AND** it SHALL NOT invoke `git tag`

#### Scenario: Missing mergeCommitOid fails before wait-release

- **WHEN** finish JSON has no 40-hex `mergeCommitOid`
- **THEN** Tugboat SHALL fail the ship
- **AND** it SHALL NOT poll `gh release view`

#### Scenario: Pack-done plus merge without ensure-tag fails the composer check

- **WHEN** an automated Tugboat check inspects the post-finish path
- **AND** that path still goes from `release finish` success to `wait-release` with no `release ensure-tag`
- **THEN** the check SHALL fail
