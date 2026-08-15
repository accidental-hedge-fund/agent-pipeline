# tugboat-thin-ship Specification

## Purpose
Defines the Option 1 thin ship composer (Tugboat): host-side composition of existing Pipeline CLI verbs with wait and notify only, so Buzz milestone ships stay single-path, fail with real reasons, and promote every configured host without a second ship brain.

## Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using the installed Pipeline CLI and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate)
2. `pipeline release X.Y.Z` with bare version (no leading `v`) and the thin-path FRG skip policy already used by the composer
3. Wait until the open release PR checks are green
4. `pipeline release finish <pr>`
5. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
6. `pipeline engine-promote --for X.Y.Z --host <resolved-host>`

The composer SHALL NOT implement a second merge policy, grant factory, durable outer ledger, or `pipeline ship` product subcommand as its ship path. The composer SHALL run `gh` and relative path work from the configured ship target repository directory (`REPO_DIR`).

#### Scenario: Phase order is fixed for a successful ship

- **WHEN** Tugboat ships milestone `vX.Y.Z` end to end without failure
- **THEN** it SHALL execute train → release prepare → CI wait → release finish → publication wait → engine-promote in that order
- **AND** it SHALL NOT skip the CI wait before release finish

#### Scenario: Thinness forbids second ship brain markers

- **WHEN** an automated thinness check inspects the Tugboat source
- **THEN** the source SHALL identify itself as the thin ship composer
- **AND** it SHALL NOT embed grant-factory or `pipeline ship ` product invocation markers as the ship path

### Requirement: Tugboat SHALL apply hard-won version prefix rules

Tugboat SHALL pass:

- `vX.Y.Z` to `pipeline train --milestone`
- bare `X.Y.Z` to `pipeline release` (a leading `v` on release is invalid)
- bare `X.Y.Z` (or equivalent accepted form) to `pipeline engine-promote --for`
- `vX.Y.Z` to `gh release view`

#### Scenario: Release is invoked with bare version

- **WHEN** Tugboat enters the release-prepare phase for version `1.38.0`
- **THEN** it SHALL invoke `pipeline release` with `1.38.0`
- **AND** it SHALL NOT invoke `pipeline release` with `v1.38.0`

### Requirement: Failed ship phases SHALL surface a real reason to state and notify

When a ship phase status is `failed`, Tugboat SHALL enrich the operator-visible detail with a non-empty reason from the phase’s blocker sidecar or error capture (for example train blocker text, release-finish err line about pending/not green checks, or promote err tail). The notify line for that failure SHALL include that reason. The detail SHALL NOT be only a bare exit code when a richer capture exists.

#### Scenario: Train blocker appears in failure detail

- **WHEN** train fails and `train.json.blocker` contains a non-empty blocker string
- **THEN** the failed train state/notify detail SHALL include that blocker text (or a prefix of it)

#### Scenario: Release-finish pending-checks line is preserved

- **WHEN** release-finish fails and the error capture mentions that observable checks are not green
- **THEN** the failed release-finish detail SHALL include that reason class of text
- **AND** it SHALL NOT collapse to only `exit 1` when that capture is present

#### Scenario: No capture yields empty enrichment without inventing a reason

- **WHEN** a phase fails and no blocker or error capture file is present
- **THEN** Tugboat SHALL still record the failure
- **AND** it SHALL NOT invent a fabricated blocker string

### Requirement: Tugboat SHALL wait for green release PR checks before release finish

Before calling `pipeline release finish`, Tugboat SHALL poll the release PR checks using a valid `gh pr checks --json` field set that includes `bucket` and SHALL NOT rely on a non-existent `conclusion` field. Tugboat SHALL call release finish only after the pure green helper reports checks green, and SHALL fail closed if checks fail or the wait budget is exhausted.

#### Scenario: Finish is not called while checks are pending

- **WHEN** the release PR checks are still pending within the wait budget
- **THEN** Tugboat SHALL continue waiting
- **AND** it SHALL NOT invoke `pipeline release finish` for that PR until the green helper reports green

#### Scenario: Failed checks fail closed before finish

- **WHEN** the green helper reports that release PR checks have failed
- **THEN** Tugboat SHALL mark the release-finish phase failed
- **AND** it SHALL NOT invoke `pipeline release finish`

### Requirement: Tugboat engine-promote SHALL default to all hosts

When `ENGINE_PROMOTE_HOST` is unset, Tugboat SHALL resolve the promote host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with existing promote flags such as `--for` and thin-path FRG skip). When the operator sets `ENGINE_PROMOTE_HOST` to a valid single host or `all`, Tugboat SHALL pass that value and SHALL NOT rewrite a single-host override to `all`.

#### Scenario: Unset host promotes all

- **WHEN** Tugboat reaches engine-promote and `ENGINE_PROMOTE_HOST` is unset
- **THEN** the promote invocation SHALL include `--host all`

#### Scenario: Explicit single-host override is honored

- **WHEN** `ENGINE_PROMOTE_HOST` is set to `codex`
- **THEN** the promote invocation SHALL include `--host codex`
- **AND** it SHALL NOT expand the host to `all`

### Requirement: Tugboat SHALL reuse an existing open release PR for the version

When release prepare exits non-zero but an open pull request whose title matches the release for bare version `X.Y.Z` (or `vX.Y.Z`) already exists, Tugboat SHALL reuse that PR number for later phases and SHALL NOT treat “could not determine release PR” as the failure mode while that open PR is present. When no open matching PR exists and release prepare fails, Tugboat SHALL fail closed.

#### Scenario: Existing open release PR is reused

- **WHEN** `pipeline release` fails or is redundant
- **AND** an open PR titled `release: X.Y.Z …` (or `release: vX.Y.Z …`) exists
- **THEN** Tugboat SHALL continue with that PR number for CI wait and release finish

#### Scenario: Missing release PR after failed prepare fails closed

- **WHEN** `pipeline release` fails
- **AND** no open matching release PR exists
- **THEN** Tugboat SHALL fail the release-prepare phase
- **AND** it SHALL NOT invent a PR number

### Requirement: Multi-milestone ships SHALL be serial with promote between

When the operator passes multiple milestones, Tugboat SHALL ship them one at a time in argument order. For each milestone, Tugboat SHALL complete the full phase sequence (including engine-promote) before starting the next milestone. Tugboat SHALL NOT run parallel fat multi-milestone state machines for one invocation.

#### Scenario: Two milestones ship serially

- **WHEN** the operator runs Tugboat with `--milestones vA.B.C vD.E.F`
- **THEN** Tugboat SHALL fully complete ship for `A.B.C` before starting ship for `D.E.F`
- **AND** it SHALL run engine-promote for `A.B.C` before train of `D.E.F`

### Requirement: Option 1 install path SHALL be a single Tugboat pack from repo examples

For hosts using Option 1 thin ship, the canonical composer entrypoint SHALL be the repo example Tugboat script (and its sibling notify, stage-watch, and pure helpers under `examples/supervisor/shell/`). Installed copies under the operator bin directory SHALL match those sources by content digest for the critical pack files: Tugboat, `release-checks-green.py`, and `train-status-complete.py` (promote default, failure detail, CI wait, thinness, and the pure helpers that enforce them). Marker-only presence SHALL NOT be accepted as proof of pack parity. The host SHALL NOT treat a divergent second ship binary as the primary Buzz ship path alongside Tugboat.

#### Scenario: Documented install names Tugboat as primary

- **WHEN** an operator reads the Option 1 ship install documentation after this change
- **THEN** the primary install instructions SHALL name Tugboat (and shared notify/stage-watch/helpers)
- **AND** they SHALL NOT present a second divergent playbook as the primary Buzz ship path

#### Scenario: Doctor or install check fails on divergent primary install

- **WHEN** a primary Option 1 ship binary is installed at the documented path
- **AND** that binary or a critical sibling helper (`release-checks-green.py`, `train-status-complete.py`) is missing or does not match the corresponding repo example content under `examples/supervisor/shell/`
- **THEN** doctor (or the pure helper it uses) SHALL fail closed with refresh remediation pointing at the repo example
- **AND** absence of any installed Option 1 ship binary SHALL skip rather than fail hosts that do not use thin ship

#### Scenario: Marker-complete divergent Tugboat fails content parity

- **WHEN** an installed Tugboat retains recognizer thin markers but its body content does not match the repo example Tugboat
- **THEN** doctor (or the pure helper it uses) SHALL fail closed
- **AND** it SHALL NOT pass solely because marker regexes match

### Requirement: Operator phrase and status surface SHALL be documented

Operator-facing supervisor documentation and the Hermes skill map SHALL document:

- Phrase `Ship milestone vX.Y.Z` maps to Tugboat detach for Option 1
- Status via Tugboat `--status` and/or state under the supervisor state directory `ship-vX.Y.Z/`
- Required env: at least `REPO_DIR`, `PIPELINE`, `ALLOW_MERGE=1` for mutating ship

#### Scenario: Hermes skill maps ship phrase to Tugboat

- **WHEN** an operator sends `Ship milestone vX.Y.Z` (or the skill’s documented equivalent) on the private factory channel with merge allowed
- **THEN** the skill documentation SHALL direct the host to detach Tugboat for that milestone
- **AND** status lookup SHALL use Tugboat `--status` or the documented state file path

#### Scenario: Status reads state without starting a new ship

- **WHEN** the operator runs Tugboat with `--status` for a milestone
- **THEN** Tugboat SHALL print the existing state (or a none/empty status when no state exists)
- **AND** it SHALL NOT start train/release/promote as a side effect of status

### Requirement: Train completion and resume SHALL fail closed without re-failing complete trains

On a fresh train capture, Tugboat SHALL require the train-status complete helper to report complete with no blocker before leaving the train phase. When train exits non-zero because the milestone has no open issues, or a prior complete train artifact exists, Tugboat SHALL treat the train phase as already complete (resume) and SHALL NOT re-fail solely on a failed capture file that is not the success artifact.

#### Scenario: Incomplete train_status blocks later phases

- **WHEN** train exits 0 but the train-status complete helper reports not complete
- **THEN** Tugboat SHALL fail the train phase
- **AND** it SHALL NOT proceed to release prepare

#### Scenario: Resume accepts prior complete artifact

- **WHEN** train exits non-zero
- **AND** a prior complete train artifact is present and the complete helper reports complete
- **THEN** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases

### Requirement: Failed train notify detail SHALL preserve train-produced stop class and reason text

When the train phase fails and the train blocker sidecar, train capture, or `train_status.blocker` contains structured stop or block diagnostic text produced by train (for example a `loop_run_stopped.reason` token such as `supervisor_no_progress`, a `loop_item_blocked.class` token, an issue number, or a blocker_kind / comment first line), Tugboat’s failed-phase state and notify detail SHALL include that text (or a faithful prefix of it). Tugboat SHALL NOT collapse the operator-visible train failure detail to an exit-only phrase when that richer train-produced text is present in the blocker or capture. Tugboat remains a thin reader of train output and SHALL NOT become a second loop-event diagnosis engine; enrichment of missing structured evidence remains train’s responsibility under `integrated-train-mode`.

#### Scenario: Structured train blocker reaches notify

- **WHEN** train fails and `train.json.blocker` (or the equivalent train capture blocker field) contains `supervisor_no_progress` and an issue number
- **THEN** the failed train state/notify detail SHALL include `supervisor_no_progress` and that issue number
- **AND** it SHALL NOT be only an exit-only phrase such as `pipeline single exited with code 1` or `train exit 1`

#### Scenario: Exit-only train blocker is not rewritten into a fake class

- **WHEN** train fails and the train blocker text is only an exit code / exit-only phrase with no structured class
- **THEN** Tugboat SHALL still surface that blocker or capture text as available
- **AND** it SHALL NOT invent a stop class name for notify
