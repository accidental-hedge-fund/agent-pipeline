## MODIFIED Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using the installed Pipeline CLI and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate)
2. FRG pack: `pipeline factory-release prepare --request <absolute-request.json> --json` in an uncredentialed child, then (when unsigned eligible artifacts exist) `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate credentialed child, re-invoked until pack-done or pack-fail
3. `pipeline release X.Y.Z` with bare version (no leading `v`) and **without** `--skip-frg` unless the operator escape is active
4. Wait until the open release PR checks are green
5. `pipeline release finish <pr>`
6. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
7. `pipeline engine-promote --for X.Y.Z --host <resolved-host>` **without** `--skip-frg` unless the operator escape is active

The composer SHALL NOT implement a second merge policy, grant factory, durable outer ledger, or `pipeline ship` product subcommand as its ship path. The composer SHALL run `gh` and relative path work from the configured ship target repository directory (`REPO_DIR`).

#### Scenario: Phase order is fixed for a successful ship

- **WHEN** Tugboat ships milestone `vX.Y.Z` end to end without failure
- **AND** the operator escape is not active
- **THEN** it SHALL execute train → FRG pack → release prepare → CI wait → release finish → publication wait → engine-promote in that order
- **AND** it SHALL NOT skip the FRG pack phase or the CI wait before release finish

#### Scenario: Thinness forbids second ship brain markers

- **WHEN** an automated thinness check inspects the Tugboat source
- **THEN** the source SHALL identify itself as the thin ship composer
- **AND** it SHALL NOT embed grant-factory or `pipeline ship ` product invocation markers as the ship path

### Requirement: Tugboat SHALL run one FRG pack phase after train and before release

After train is complete or resumed complete, and when the operator escape is not active, Tugboat SHALL run exactly one Factory Reliability Gate (FRG) pack phase before `pipeline release`. That phase SHALL compose `pipeline factory-release prepare --request <absolute-request.json> --json` (or the documented #1037 CLI sequence) with a secret-free request bound to the ship version and candidate. The request `base_branch` SHALL be the operator `TUGBOAT_BASE_BRANCH` when set, else the top-level `base_branch` from `.github/pipeline.yml` (the same source train and release use). It SHALL preserve slash-containing names such as `release/1.39`. It SHALL NOT guess `origin/HEAD` or take only the last path segment of a remote ref. When both the env override and the pipeline.yml source are unavailable, Tugboat SHALL fail before writing the request. The request `integrated_candidate.git_sha` SHALL be the current remote tip of the configured integration `base_branch` after train (via `origin/<base>` `ls-remote` or fetch, or injected `TUGBOAT_CANDIDATE_SHA`). It SHALL NOT default to the local checkout `HEAD`, which remains at the pre-train SHA when train merges through GitHub. Tugboat SHALL re-invoke the unchanged request until pack-done or pack-fail. Tugboat SHALL NOT start a second unbound pack and SHALL NOT implement a second pack runner. Tugboat SHALL NOT merge, tag, promote, or install in this phase. Tugboat SHALL NOT invent `pass: true`. Tugboat SHALL NOT persist the FRG key body in `state.json`.

The prepare child process SHALL have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset, even when the parent supervisor environment has one or both set. Tugboat SHALL NOT invoke prepare in an environment that still carries those variables.

When prepare returns `status: "awaiting_frg_attestation"`, or when unsigned eligible artifacts exist for the bound request and no matching `latest.json` `pass: true` exists, Tugboat SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a **separate** child process. `<loop>` SHALL be the bound pack `loop_run_id` from the prepare result (`loop_run_id` on `in_progress`, or `frg.loop_run_id` on `awaiting_frg_attestation`). That attestor child SHALL NOT pass `--observations`. That attestor child SHALL have the producer credential available to factory-gate: inherit `PIPELINE_FRG_ATTESTATION_KEY` when set, and when the supervisor supplied only `PIPELINE_FRG_ATTESTATION_KEY_FILE`, present that file's contents as `PIPELINE_FRG_ATTESTATION_KEY` in the attestor child only. Tugboat SHALL NOT run that attestor inside the prepare process.

Pack-done SHALL mean `.agent-pipeline/frg/<X.Y.Z>/latest.json` has `pass: true` and records the request `target_version` and `integrated_candidate.git_sha` (and `action_id` when the artifact records one), or prepare already returned `status: "complete"` with an open release PR for that version. Prepare JSON `status: "awaiting_frg_attestation"` alone SHALL NOT be pack-done. A `pass: true` artifact that lacks that binding, or that binds a different version or candidate SHA, SHALL NOT be pack-done; Tugboat SHALL re-invoke while prepare status is `in_progress`. A `latest.json` `pass: false` SHALL be evaluated before any success status: `awaiting_frg_attestation` or `complete` paired with `pass: false` is pack-fail. `status: "complete"` is pack-done only after an open release PR for that version is verified; a bare complete response with no open release PR is pack-fail. Pack-fail SHALL mean a failed or missing FRG status, `latest.json` `pass: false` after a terminal score, attestor child failure or missing producer credential after unsigned artifacts exist, or wait-budget exhaustion while status stays `in_progress`. On pack-fail Tugboat SHALL fail the frg-pack phase and SHALL NOT invoke `pipeline release` for that version.

#### Scenario: Request binds the post-train integration tip

- **WHEN** train completes by merging through GitHub
- **AND** the local checkout `HEAD` is still the pre-train SHA
- **AND** the operator escape is not active
- **THEN** the factory-release prepare request SHALL set `integrated_candidate.git_sha` to the current remote tip of the configured base branch
- **AND** it SHALL NOT bind `integrated_candidate.git_sha` to the pre-train local `HEAD`

#### Scenario: Request uses configured integration branch not origin HEAD

- **WHEN** `TUGBOAT_BASE_BRANCH` is unset
- **AND** `.github/pipeline.yml` sets `base_branch` to `staging`
- **AND** `origin/HEAD` points at `main`
- **THEN** the factory-release prepare request `base_branch` SHALL be `staging`
- **AND** `integrated_candidate.git_sha` SHALL be the current remote tip of `origin/staging`

#### Scenario: Slash-containing integration branch names are preserved

- **WHEN** the configured base branch is `release/1.39`
- **THEN** the request `base_branch` SHALL be `release/1.39`
- **AND** the candidate SHALL bind the `origin/release/1.39` tip

#### Scenario: Quoted pipeline.yml key binds the configured branch

- **WHEN** `TUGBOAT_BASE_BRANCH` is unset
- **AND** `.github/pipeline.yml` sets `"base_branch": staging`
- **THEN** the factory-release prepare request `base_branch` SHALL be `staging`
- **AND** it SHALL NOT bind `main` as if the key were absent

#### Scenario: Embedded hash in the configured branch name is preserved

- **WHEN** `TUGBOAT_BASE_BRANCH` is unset
- **AND** `.github/pipeline.yml` sets `base_branch` to the unquoted scalar `deploy#blue`
- **THEN** the request `base_branch` SHALL be `deploy#blue`
- **AND** it SHALL NOT truncate the name at `#`

#### Scenario: Missing integration-branch source fails before write

- **WHEN** `TUGBOAT_BASE_BRANCH` is unset
- **AND** `.github/pipeline.yml` is absent
- **THEN** Tugboat SHALL fail before writing the factory-release prepare request
- **AND** it SHALL NOT guess `origin/HEAD` or default to `main` from that ref

#### Scenario: Prepare child unsets attestor env

- **WHEN** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **AND** Tugboat invokes `pipeline factory-release prepare`
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Awaiting attestation alone is not pack-done

- **WHEN** prepare returns `status: "awaiting_frg_attestation"`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is missing or is not `pass: true` for the requested candidate SHA
- **THEN** Tugboat SHALL NOT treat pack as done
- **AND** it SHALL NOT invoke `pipeline release` until pack-done

#### Scenario: Attestor child signs outside prepare

- **WHEN** prepare returns `status: "awaiting_frg_attestation"` for version `1.39.0`
- **AND** the bound pack `loop_run_id` is `L`
- **AND** no matching `latest.json` `pass: true` exists
- **THEN** Tugboat SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child process other than prepare
- **AND** that child SHALL have the producer credential
- **AND** that child SHALL NOT pass `--observations`
- **AND** prepare SHALL already have returned without that credential in its environment

#### Scenario: Successful pack precedes release

- **WHEN** train is complete for version `1.39.0`
- **AND** the operator escape is not active
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: true` for the requested candidate SHA
- **THEN** Tugboat SHALL mark the FRG pack phase ok
- **AND** it SHALL proceed to `pipeline release 1.39.0` without `--skip-frg`

#### Scenario: Supervisor KEY_FILE does not require a human unset

- **WHEN** the supervisor environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** train is already complete for the milestone
- **AND** the operator escape is not active
- **THEN** Tugboat SHALL finish the FRG pack phase when the attestor child writes bound `latest.json` `pass: true`
- **AND** it SHALL NOT require a human to unset attestor env before prepare

#### Scenario: Stale passing latest.json does not complete a newer candidate

- **WHEN** train advances the integration branch to a new candidate SHA
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: true` bound to a prior SHA
- **AND** prepare returns `status: "in_progress"` for the new request
- **THEN** Tugboat SHALL NOT treat pack as done
- **AND** it SHALL re-invoke the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done for the new candidate

#### Scenario: In-progress pack is re-invoked and does not release

- **WHEN** prepare returns `status: "in_progress"` within the wait budget
- **AND** the prepare result does not include unsigned eligible artifacts
- **THEN** Tugboat SHALL re-invoke the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done

#### Scenario: In-progress unsigned eligible artifacts are attested

- **WHEN** prepare returns `status: "in_progress"` for version `1.39.0`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** the bound pack `loop_run_id` is `L`
- **AND** no matching `latest.json` `pass: true` exists
- **THEN** Tugboat SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child process other than prepare
- **AND** that child SHALL have the producer credential
- **AND** that child SHALL NOT pass `--observations`
- **AND** Tugboat SHALL NOT treat that tick as wait-only retry

#### Scenario: Failed pack stops the ship before release

- **WHEN** prepare reports a failed or missing FRG status
- **OR** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: false` after a terminal score
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for `1.39.0`

#### Scenario: Failed latest evidence blocks awaiting or complete

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: false`
- **AND** prepare status is `awaiting_frg_attestation` or `complete`
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for `1.39.0`

#### Scenario: Complete without an open release PR is not pack-done

- **WHEN** prepare returns `status: "complete"`
- **AND** no open release PR exists for that version
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT treat pack as done

#### Scenario: Missing attestor credential after unsigned artifacts is pack-fail

- **WHEN** prepare returns `status: "awaiting_frg_attestation"`
- **AND** the attestor child has neither `PIPELINE_FRG_ATTESTATION_KEY` nor a readable `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT treat pack as done
- **AND** it SHALL NOT pass `--skip-frg`

#### Scenario: Pack phase does not sign or finalize

- **WHEN** Tugboat runs the FRG pack phase
- **THEN** it SHALL NOT merge a release PR, tag, promote a pin, or install
- **AND** it SHALL NOT invent `pass: true`
- **AND** it SHALL NOT write the FRG key body into `state.json`
- **AND** it SHALL NOT implement a second HMAC or grant-factory attestor (compose `factory-gate --from-run` only)

## ADDED Requirements

### Requirement: Tugboat FRG pack attestor isolation SHALL be regression-tested

Tugboat pack-phase isolation (uncredentialed prepare child, credentialed `factory-gate --from-run` attestor child, pack-done only on bound `latest.json` `pass: true`) SHALL be covered by automated checks that fail if:

- prepare is invoked with `PIPELINE_FRG_ATTESTATION_KEY` or `PIPELINE_FRG_ATTESTATION_KEY_FILE` set in that child,
- pack-done is declared for `awaiting_frg_attestation` without a matching `pass: true` `latest.json`,
- `in_progress` with unsigned eligible artifacts is classified as wait-only retry,
- or the pack phase writes the key body into `state.json`.

#### Scenario: Regression fails if prepare inherits KEY_FILE

- **WHEN** the automated pack-isolation checks run against a Tugboat implementation that invokes prepare with `PIPELINE_FRG_ATTESTATION_KEY_FILE` still set
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if awaiting is pack-done

- **WHEN** the automated pack-isolation checks classify a tick whose prepare status is `awaiting_frg_attestation` and whose `latest.json` is missing or not bound `pass: true`
- **THEN** the checks SHALL NOT accept pack-done
- **AND** the checks SHALL fail if the classifier still prints `done` for that tick

#### Scenario: Regression fails if in-progress unsigned artifacts stay retry

- **WHEN** the automated pack-isolation checks classify a tick whose prepare status is `in_progress` and whose prepare result includes unsigned eligible artifacts
- **AND** `latest.json` is missing or is not bound `pass: true`
- **THEN** the checks SHALL print `attest`
- **AND** the checks SHALL fail if the classifier still prints `retry` for that tick
