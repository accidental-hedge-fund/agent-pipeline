# tugboat-thin-ship Specification

## Purpose
Defines the Option 1 thin ship composer (Tugboat): host-side composition of existing Pipeline CLI verbs with wait and notify only, so Buzz milestone ships stay single-path, fail with real reasons, and promote every configured host without a second ship brain.

## Requirements

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

When `ENGINE_PROMOTE_HOST` is unset, Tugboat SHALL resolve the promote host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with existing promote flags such as `--for`). Default promote argv SHALL omit `--skip-frg`. When the operator sets `ENGINE_PROMOTE_HOST` to a valid single host or `all`, Tugboat SHALL pass that value and SHALL NOT rewrite a single-host override to `all`.

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

### Requirement: Live ship for a milestone SHALL mean live train --merge or its owning tugboat

For Option 1 thin ship, a milestone SHALL be considered to have a **live ship** only when at least one of the following is true on the host:

1. A live process exists whose command line is the Pipeline train ship invocation for that milestone, including both the milestone coordinate and `--merge` (the detached `pipeline train --milestone vX.Y.Z --merge` form Tugboat launches), or
2. A live tugboat process exists that owns (or is the parent composer of) that train for the same milestone.

The following SHALL NOT by themselves constitute a live ship for that milestone:

- Presence of `playbook.pid` (or lock pid file) with only `kill -0` success and no matching train/tugboat cmdline
- A per-issue issue-run lock for `pipeline N` / `pipeline single N` (or equivalent host-local issue lock)
- Stale `state.json` alone, including a recorded status of `running` without a live matching process

#### Scenario: Live train --merge cmdline is a live ship

- **WHEN** a process is live and its cmdline is `train` with `--merge` for milestone `vX.Y.Z`
- **THEN** the live-ship probe for `vX.Y.Z` SHALL report live
- **AND** a second detach for that milestone SHALL be refused

#### Scenario: Bare playbook.pid with kill -0 is not a live ship

- **WHEN** `playbook.pid` (or lock pid) exists and the pid is alive
- **AND** that process cmdline is not train `--merge` for the milestone and is not the owning tugboat for that milestone
- **THEN** the live-ship probe SHALL report not live
- **AND** Ship SHALL still be allowed to detach once

#### Scenario: Per-issue pipeline lock is not a live ship

- **WHEN** a host-local issue-run lock is held for some issue `N` (for example `pipeline single N` or `pipeline N`)
- **AND** no live train `--merge` / owning tugboat exists for the requested milestone
- **THEN** the live-ship probe SHALL report not live
- **AND** Ship for that milestone SHALL detach (it SHALL NOT refuse solely because of the issue lock)

### Requirement: Ship detach path SHALL use the live-ship probe only

When the operator requests Option 1 Ship for a milestone (Buzz phrase or TUI paste of the same intent), Tugboat SHALL use one path:

- If the live-ship probe reports live for that milestone: report status for the milestone, notify that the ship is already running, and SHALL NOT start a second detached ship.
- If the live-ship probe reports not live: detach exactly one ship for that request.

Tugboat SHALL NOT implement a separate “paste detector” or chat-history heuristic to decide whether to detach. Buzz and TUI paste SHALL share this path.

#### Scenario: Second Ship while live reports status and does not stack

- **WHEN** a live ship exists for `vX.Y.Z`
- **AND** the operator issues Ship for `vX.Y.Z` again (Buzz or TUI paste)
- **THEN** Tugboat SHALL surface status (or equivalent already-running report) and notify
- **AND** it SHALL NOT spawn a second detached tugboat/train for that milestone

#### Scenario: Ship with no live ship detaches once

- **WHEN** no live ship exists for `vX.Y.Z`
- **AND** the operator issues Ship for `vX.Y.Z`
- **THEN** Tugboat SHALL detach exactly one ship process for that milestone
- **AND** it SHALL NOT refuse solely due to bare pid files, issue locks, or stale state

### Requirement: Tugboat SHALL pin REPO_DIR at start and refuse factory-control

At tugboat process start, Tugboat SHALL resolve `REPO_DIR` once from the host environment / install configuration and SHALL use that resolved path for the ship run. After that pin, Tugboat SHALL NOT retarget the ship repository from session, model, or free-text overrides. If the resolved path matches `*factory-control*` (path contains that segment), Tugboat SHALL refuse to start or detach the ship and SHALL emit a clear error naming the refused plane. The Hermes supervisor `env.example` template shipped in this repository SHALL NOT default `REPO_DIR` to a `*factory-control*` path.

#### Scenario: factory-control REPO_DIR is refused

- **WHEN** `REPO_DIR` resolves to a path containing `factory-control`
- **THEN** Tugboat SHALL exit non-zero (or otherwise fail closed) without detaching a ship
- **AND** the operator-visible error SHALL indicate the path is refused

#### Scenario: env.example does not default to factory-control

- **WHEN** an operator reads `examples/supervisor/hermes/env.example`
- **THEN** the example `REPO_DIR` value SHALL NOT be a path matching `*factory-control*`

#### Scenario: Session text cannot retarget after pin

- **WHEN** tugboat has resolved `REPO_DIR` at process start
- **THEN** subsequent model or session text SHALL NOT change the ship working repository for that process

### Requirement: Status SHALL NOT claim running from a dead pid or stale state alone

When Tugboat is invoked with `--status` for a milestone, it SHALL NOT report the ship as **running** solely because `state.json` records a running phase or a pid file exists. If the recorded holder is dead or the live-ship probe reports not live, status SHALL report a non-running outcome (for example `none`, `stale`, or the last terminal status) rather than implying an active ship.

#### Scenario: Dead pid status is not running

- **WHEN** the operator runs Tugboat `--status` for a milestone
- **AND** the only evidence of activity is a dead recorded pid and/or stale `state.json` with status `running`
- **THEN** the status output SHALL NOT claim the ship is running
- **AND** status SHALL still be read-only (no train/release/promote side effect)

#### Scenario: Live ship status may report running

- **WHEN** the live-ship probe reports live for the milestone
- **AND** the operator runs Tugboat `--status`
- **THEN** status MAY report an in-progress / running phase consistent with the live process
- **AND** it SHALL NOT start a new ship as a side effect of status

### Requirement: Live-ship probe and REPO_DIR refuse SHALL be regression-tested

The live-ship probe rules (train `--merge` / owning tugboat vs bare pid vs issue lock) and the `*factory-control*` REPO_DIR refuse rule SHALL be covered by automated checks (pure helper fixtures and/or source/static assertions against Tugboat and `env.example`) that fail if:

- detach refuse returns to bare `playbook.pid` + `kill -0` only,
- an issue-run lock alone blocks detach,
- `env.example` defaults `REPO_DIR` to `*factory-control*` again,
- or status claims running from dead pid / stale state alone.

#### Scenario: Regression fails if probe is only kill -0 on playbook.pid

- **WHEN** the automated live-ship probe checks run against a Tugboat implementation that refuses detach solely because `playbook.pid` is alive without train/tugboat cmdline match
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if env.example points at factory-control

- **WHEN** the automated check reads `examples/supervisor/hermes/env.example` and `REPO_DIR` matches `*factory-control*`
- **THEN** the check SHALL fail

### Requirement: Tugboat SHALL run one FRG pack phase after train and before release

After train is complete or resumed complete, and when the operator escape is not active, Tugboat SHALL run exactly one Factory Reliability Gate (FRG) pack phase before `pipeline release`. That phase SHALL compose `pipeline factory-release prepare --request <absolute-request.json> --json` (or the documented #1037 CLI sequence) with a secret-free request bound to the ship version and candidate. The request `base_branch` SHALL be the operator `TUGBOAT_BASE_BRANCH` when set, else the top-level `base_branch` from `.github/pipeline.yml` (the same source train and release use). It SHALL preserve slash-containing names such as `release/1.39`. It SHALL NOT guess `origin/HEAD` or take only the last path segment of a remote ref. When both the env override and the pipeline.yml source are unavailable, Tugboat SHALL fail before writing the request. The request `integrated_candidate.git_sha` SHALL be the current remote tip of the configured integration `base_branch` after train (via `origin/<base>` `ls-remote` or fetch, or injected `TUGBOAT_CANDIDATE_SHA`). It SHALL NOT default to the local checkout `HEAD`, which remains at the pre-train SHA when train merges through GitHub. Tugboat SHALL re-invoke the unchanged request until pack-done or pack-fail. Tugboat SHALL NOT start a second unbound pack, SHALL NOT implement a second pack runner, and SHALL NOT sign attestation, merge, tag, promote, or install in this phase.

Pack-done SHALL mean prepare JSON `status` is `awaiting_frg_attestation`, or `.agent-pipeline/frg/<X.Y.Z>/latest.json` has `pass: true` and records the request `target_version` and `integrated_candidate.git_sha` (and `action_id` when the artifact records one), or prepare already returned `status: "complete"` with an open release PR for that version. A `pass: true` artifact that lacks that binding, or that binds a different version or candidate SHA, SHALL NOT be pack-done; Tugboat SHALL re-invoke while prepare status is `in_progress`. A `latest.json` `pass: false` SHALL be evaluated before any success status: `awaiting_frg_attestation` or `complete` paired with `pass: false` is pack-fail. `status: "complete"` is pack-done only after an open release PR for that version is verified; a bare complete response with no open release PR is pack-fail. Pack-fail SHALL mean a failed or missing FRG status, `latest.json` `pass: false` after a terminal score, or wait-budget exhaustion while status stays `in_progress`. On pack-fail Tugboat SHALL fail the frg-pack phase and SHALL NOT invoke `pipeline release` for that version.

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

#### Scenario: Successful pack precedes release

- **WHEN** train is complete for version `1.39.0`
- **AND** the operator escape is not active
- **AND** prepare returns `status: "awaiting_frg_attestation"` or `latest.json` for `1.39.0` has `pass: true` for the requested candidate SHA
- **THEN** Tugboat SHALL mark the FRG pack phase ok
- **AND** it SHALL proceed to `pipeline release 1.39.0` without `--skip-frg`

#### Scenario: Stale passing latest.json does not complete a newer candidate

- **WHEN** train advances the integration branch to a new candidate SHA
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: true` bound to a prior SHA
- **AND** prepare returns `status: "in_progress"` for the new request
- **THEN** Tugboat SHALL NOT treat pack as done
- **AND** it SHALL re-invoke the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done for the new candidate

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
