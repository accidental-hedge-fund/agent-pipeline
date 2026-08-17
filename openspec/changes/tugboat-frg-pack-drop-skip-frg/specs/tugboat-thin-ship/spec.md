## MODIFIED Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using the installed Pipeline CLI and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate)
2. FRG pack: `pipeline factory-release prepare --request <absolute-request.json> --json` (or the documented #1037 sequence), re-invoked until pack-done or pack-fail
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

### Requirement: Tugboat engine-promote SHALL default to all hosts

When `ENGINE_PROMOTE_HOST` is unset, Tugboat SHALL resolve the promote host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with existing promote flags such as `--for`). Default promote argv SHALL omit `--skip-frg`. When the operator sets `ENGINE_PROMOTE_HOST` to a valid single host or `all`, Tugboat SHALL pass that value and SHALL NOT rewrite a single-host override to `all`.

#### Scenario: Unset host promotes all

- **WHEN** Tugboat reaches engine-promote and `ENGINE_PROMOTE_HOST` is unset
- **THEN** the promote invocation SHALL include `--host all`

#### Scenario: Explicit single-host override is honored

- **WHEN** `ENGINE_PROMOTE_HOST` is set to `codex`
- **THEN** the promote invocation SHALL include `--host codex`
- **AND** it SHALL NOT expand the host to `all`

### Requirement: Train completion and resume SHALL fail closed without re-failing complete trains

On a fresh train capture, Tugboat SHALL require the train-status complete helper to report complete with no blocker before leaving the train phase. When train exits non-zero because the milestone has no open issues, or a prior complete train artifact exists, Tugboat SHALL treat the train phase as already complete (resume) and SHALL NOT re-fail solely on a failed capture file that is not the success artifact.

#### Scenario: Incomplete train_status blocks later phases

- **WHEN** train exits 0 but the train-status complete helper reports not complete
- **THEN** Tugboat SHALL fail the train phase
- **AND** it SHALL NOT proceed to the FRG pack phase or release prepare

#### Scenario: Resume accepts prior complete artifact

- **WHEN** train exits non-zero
- **AND** a prior complete train artifact is present and the complete helper reports complete
- **THEN** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases

### Requirement: Operator phrase and status surface SHALL be documented

Operator-facing supervisor documentation and the Hermes skill map SHALL document:

- Phrase `Ship milestone vX.Y.Z` maps to Tugboat detach for Option 1
- Default Tugboat sequence is train → FRG pack → release (no `--skip-frg`) → finish → promote
- `--skip-frg` (or the documented env) is an operator escape with a logged reason, not the default
- Status via Tugboat `--status` and/or state under the supervisor state directory `ship-vX.Y.Z/`
- Required env: at least `REPO_DIR`, `PIPELINE`, `ALLOW_MERGE=1` for mutating ship

#### Scenario: Hermes skill maps ship phrase to Tugboat

- **WHEN** an operator sends `Ship milestone vX.Y.Z` (or the skill’s documented equivalent) on the private factory channel with merge allowed
- **THEN** the skill documentation SHALL direct the host to detach Tugboat for that milestone
- **AND** status lookup SHALL use Tugboat `--status` or the documented state file path

#### Scenario: Hermes skill default is FRG pack then release

- **WHEN** an operator reads the Hermes `pipeline-supervisor` skill or the ship-milestone runbook after this change
- **THEN** the documented default SHALL be FRG pack then release without `--skip-frg`
- **AND** skip SHALL be documented as an operator escape with a logged reason only
- **AND** the text SHALL NOT say FRG is optional or advisory on the thin ship path

#### Scenario: Status reads state without starting a new ship

- **WHEN** the operator runs Tugboat with `--status` for a milestone
- **THEN** Tugboat SHALL print the existing state (or a none/empty status when no state exists)
- **AND** it SHALL NOT start train/FRG pack/release/promote as a side effect of status

## ADDED Requirements

### Requirement: Tugboat SHALL run one FRG pack phase after train and before release

After train is complete or resumed complete, and when the operator escape is not active, Tugboat SHALL run exactly one Factory Reliability Gate (FRG) pack phase before `pipeline release`. That phase SHALL compose `pipeline factory-release prepare --request <absolute-request.json> --json` (or the documented #1037 CLI sequence) with a secret-free request bound to the ship version and candidate. The request `base_branch` SHALL be the operator `TUGBOAT_BASE_BRANCH` when set, else the top-level `base_branch` from `.github/pipeline.yml` (the same source train and release use). It SHALL preserve slash-containing names such as `release/1.39`. It SHALL NOT guess `origin/HEAD` or take only the last path segment of a remote ref. When both the env override and the pipeline.yml source are unavailable, Tugboat SHALL fail before writing the request. The request `integrated_candidate.git_sha` SHALL be the current remote tip of the configured integration `base_branch` after train (via `origin/<base>` `ls-remote` or fetch, or injected `TUGBOAT_CANDIDATE_SHA`). It SHALL NOT default to the local checkout `HEAD`, which remains at the pre-train SHA when train merges through GitHub. Tugboat SHALL re-invoke the unchanged request until pack-done or pack-fail. Tugboat SHALL NOT start a second unbound pack, SHALL NOT implement a second pack runner, and SHALL NOT sign attestation, merge, tag, promote, or install in this phase.

Pack-done SHALL mean prepare JSON `status` is `awaiting_frg_attestation`, or `.agent-pipeline/frg/<X.Y.Z>/latest.json` has `pass: true`, or prepare already returned `status: "complete"` with an open release PR for that version. A `latest.json` `pass: false` SHALL be evaluated before any success status: `awaiting_frg_attestation` or `complete` paired with `pass: false` is pack-fail. `status: "complete"` is pack-done only after an open release PR for that version is verified; a bare complete response with no open release PR is pack-fail. Pack-fail SHALL mean a failed or missing FRG status, `latest.json` `pass: false` after a terminal score, or wait-budget exhaustion while status stays `in_progress`. On pack-fail Tugboat SHALL fail the frg-pack phase and SHALL NOT invoke `pipeline release` for that version.

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

#### Scenario: Missing integration-branch source fails before write

- **WHEN** `TUGBOAT_BASE_BRANCH` is unset
- **AND** `.github/pipeline.yml` is absent
- **THEN** Tugboat SHALL fail before writing the factory-release prepare request
- **AND** it SHALL NOT guess `origin/HEAD` or default to `main` from that ref

#### Scenario: Successful pack precedes release

- **WHEN** train is complete for version `1.39.0`
- **AND** the operator escape is not active
- **AND** prepare returns `status: "awaiting_frg_attestation"` or `latest.json` for `1.39.0` has `pass: true`
- **THEN** Tugboat SHALL mark the FRG pack phase ok
- **AND** it SHALL proceed to `pipeline release 1.39.0` without `--skip-frg`

#### Scenario: In-progress pack is re-invoked and does not release

- **WHEN** prepare returns `status: "in_progress"` within the wait budget
- **THEN** Tugboat SHALL re-invoke the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done

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

#### Scenario: Pack phase does not sign or finalize

- **WHEN** Tugboat runs the FRG pack phase
- **THEN** it SHALL NOT submit attestation, merge a release PR, tag, promote a pin, or install
- **AND** it SHALL NOT invent `pass: true`

### Requirement: Tugboat default release and promote argv SHALL omit skip-frg

When the operator escape is not active, Tugboat SHALL invoke `pipeline release` with bare version and `--no-edit` and SHALL NOT pass `--skip-frg`. Tugboat SHALL invoke `pipeline engine-promote` with `--for`, `--host`, and `--json` as today and SHALL NOT pass `--skip-frg`. This is the default for the shipped Option 1 composer used by `accidental-hedge-fund/agent-pipeline`. Tugboat SHALL NOT select skip vs pack by matching the GitHub owner/repo string.

#### Scenario: Default release argv has no skip-frg

- **WHEN** Tugboat enters the release-prepare phase
- **AND** the operator escape is not active
- **THEN** the release invocation SHALL include the bare version and `--no-edit`
- **AND** it SHALL NOT include `--skip-frg`

#### Scenario: Default promote argv has no skip-frg

- **WHEN** Tugboat enters the engine-promote phase
- **AND** the operator escape is not active
- **THEN** the promote invocation SHALL include `--for` and `--host`
- **AND** it SHALL NOT include `--skip-frg`

### Requirement: Tugboat skip-frg escape SHALL require a logged reason

Tugboat SHALL treat `--skip-frg` or env `TUGBOAT_SKIP_FRG=1` as an operator escape only when a non-empty reason is also supplied (`--skip-frg-reason` or `TUGBOAT_SKIP_FRG_REASON`). On a valid escape Tugboat SHALL omit the FRG pack phase, pass `--skip-frg` to `pipeline release` and `pipeline engine-promote`, and write the reason into the ship state or log. When skip is requested without a non-empty reason, Tugboat SHALL fail closed and SHALL NOT skip the pack or pass `--skip-frg`.

#### Scenario: Escape with reason skips pack and passes skip-frg

- **WHEN** the operator runs Tugboat with `--skip-frg` and a non-empty `--skip-frg-reason`
- **THEN** Tugboat SHALL omit the FRG pack phase
- **AND** it SHALL invoke `pipeline release` with `--skip-frg`
- **AND** it SHALL invoke `pipeline engine-promote` with `--skip-frg`
- **AND** the ship state or log SHALL contain that reason

#### Scenario: Env escape with reason works the same

- **WHEN** `TUGBOAT_SKIP_FRG` is `1`
- **AND** `TUGBOAT_SKIP_FRG_REASON` is a non-empty string
- **THEN** Tugboat SHALL omit the FRG pack phase
- **AND** it SHALL pass `--skip-frg` to release and promote
- **AND** the ship state or log SHALL contain that reason

#### Scenario: Skip without reason fails closed

- **WHEN** the operator requests `--skip-frg` or `TUGBOAT_SKIP_FRG=1`
- **AND** no non-empty reason is supplied
- **THEN** Tugboat SHALL fail closed
- **AND** it SHALL NOT omit the pack phase as a successful skip
- **AND** it SHALL NOT invoke release or promote with `--skip-frg`

### Requirement: Tugboat pack-and-no-skip default SHALL be regression-tested

Automated composer or unit checks SHALL fail if default Tugboat `ship_one` release or promote argv still contain `--skip-frg`, if the default path has no FRG pack compose of `factory-release prepare` (or the documented #1037 sequence), or if the logged-reason escape can no longer pass `--skip-frg`. Those checks SHALL inspect fixtures or source and SHALL NOT start a live pack, network call, or subprocess ship.

#### Scenario: Default argv regression fails on leftover skip-frg

- **WHEN** the automated Tugboat composer checks run against a `ship_one` body whose default release or promote argv still include `--skip-frg`
- **THEN** the checks SHALL fail

#### Scenario: Missing pack phase fails the composer check

- **WHEN** the automated Tugboat composer checks run against a `ship_one` body that has no `factory-release prepare` (or documented #1037) compose on the default path
- **THEN** the checks SHALL fail

#### Scenario: Escape path still passes skip-frg

- **WHEN** the automated checks exercise the skip escape with a non-empty reason
- **THEN** the expected release and promote argv SHALL include `--skip-frg`
- **AND** the pack phase SHALL be omitted on that path

## REMOVED Requirements

### Requirement: Tugboat default skip-frg SHALL remain until one post-1.33 honest FRG pass exists

**Reason:** Issue #1038 landed the honest-pass checker and one accepted post-1.33 `pass: true`. This child consumes that precondition. Keeping default `--skip-frg` and forbidding the pack phase is now the wrong thin-path policy.

**Migration:** Use the added FRG pack phase, default no-skip argv, and logged-reason escape requirements in this change. Do not keep the #1038 keep-skip rule as living Tugboat law.
