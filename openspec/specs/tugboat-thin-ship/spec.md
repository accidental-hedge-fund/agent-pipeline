# tugboat-thin-ship Specification

## Purpose
Defines the Option 1 thin ship composer (Tugboat): host-side composition of existing Pipeline CLI verbs with wait and notify only, so Buzz milestone ships stay single-path, fail with real reasons, and promote every configured host without a second ship brain.

## Requirements

### Requirement: Tugboat SHALL compose only the fixed thin ship phase sequence

The thin ship composer SHALL sequence exactly these phases for one milestone version, using Pipeline CLI verbs and wait helpers only:

1. `pipeline train --milestone vX.Y.Z --merge` (JSON capture for the train completion gate), invoked via the **production-pin** CLI (`$PIPELINE` / the last promoted install)
2. FRG pack: `pipeline factory-release prepare --request <absolute-request.json> --json` in an uncredentialed child, then (when unsigned eligible artifacts exist) `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate credentialed child, re-invoked until pack-done or pack-fail, invoked via the **candidate** engine
3. `pipeline release X.Y.Z` with bare version (no leading `v`) and **without** `--skip-frg` unless the operator escape is active, invoked via the **candidate** engine
4. Wait until the open release PR checks are green
5. `pipeline release finish <pr>`, invoked via the **candidate** engine
6. `pipeline release ensure-tag <X.Y.Z> <mergeCommitOid> --packed-candidate <integrated_candidate.git_sha>`, invoked via the **candidate** engine, using `mergeCommitOid` from finish JSON and packed SHA from the factory-release request
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

Before calling `pipeline release finish`, Tugboat SHALL poll the release PR checks using a valid `gh pr checks --json` field set that includes `bucket` and `link` and SHALL NOT rely on a non-existent `conclusion` field. Tugboat SHALL call release finish only after the shared wait helper reports checks green. Tugboat SHALL apply the shared `ship-release-check-wait` recipe on a settled fail: a flake-eligible `test` (or documented equivalent) fail SHALL request a bounded `gh run rerun --failed` and resume wait; Tugboat SHALL fail closed only after that budget is spent or the fail includes a non-test product check. Tugboat SHALL also fail closed if the wait-attempt budget is exhausted while checks are still not green.

#### Scenario: Finish is not called while checks are pending

- **WHEN** the release PR checks are still pending within the wait budget
- **THEN** Tugboat SHALL continue waiting
- **AND** it SHALL NOT invoke `pipeline release finish` for that PR until the green helper reports green

#### Scenario: Failed checks fail closed before finish

- **WHEN** the shared wait helper reports that release PR checks are a terminal `fail`
- **THEN** Tugboat SHALL mark the release-finish phase failed
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: First flake-eligible fail reruns then waits

- **WHEN** the shared wait helper reports `rerun` for a settled `test` fail
- **AND** rerun budget remains
- **THEN** Tugboat SHALL request `gh run rerun --failed`
- **AND** it SHALL continue waiting
- **AND** it SHALL NOT mark release-finish failed on that poll

#### Scenario: Green after rerun calls finish

- **WHEN** Tugboat has requested one rerun for a `test` fail
- **AND** a later poll reports checks green
- **THEN** Tugboat SHALL invoke `pipeline release finish` for that same PR

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

### Requirement: Train completion and resume SHALL fail closed without re-failing complete trains

On a fresh train capture, Tugboat SHALL require the train-status complete helper to report complete with no blocker before leaving the train phase. When train exits non-zero because the milestone has no open issues, or a prior complete train artifact exists, Tugboat SHALL treat the train phase as already complete (resume) and SHALL NOT re-fail solely on a failed capture file that is not the success artifact.

When Tugboat treats train as already complete, Tugboat SHALL write a non-empty `train.complete.json` in that ship `RUN_DIR` before candidate composer re-exec. Tugboat SHALL NOT leave only a 0-byte `train.json` as the skip-train artifact. If `train.json` is already a non-empty success capture, Tugboat MAY copy it to `train.complete.json`. If `train.json` is empty or is an error capture, Tugboat SHALL write a non-empty complete artifact whose last `train_status` object has `complete` true and no blocker.

#### Scenario: Incomplete train_status blocks later phases

- **WHEN** train exits 0 but the train-status complete helper reports not complete
- **THEN** Tugboat SHALL fail the train phase
- **AND** it SHALL NOT proceed to the FRG pack phase or release prepare

#### Scenario: Resume accepts prior complete artifact

- **WHEN** train exits non-zero
- **AND** a prior complete train artifact is present and the complete helper reports complete
- **THEN** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases

#### Scenario: Empty-milestone resume writes a non-empty complete artifact

- **WHEN** train exits non-zero because the milestone has no open issues
- **AND** `train.json` is empty (0 bytes)
- **AND** `train.complete.json` is absent
- **THEN** Tugboat SHALL write a non-empty `train.complete.json`
- **AND** that artifact's last `train_status` SHALL have `complete` true and no blocker
- **AND** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases including candidate composer re-exec

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

After train is complete or resumed complete, and when the operator escape is not active, Tugboat SHALL run exactly one Factory Reliability Gate (FRG) pack phase before `pipeline release`. That phase SHALL compose `pipeline factory-release prepare --request <absolute-request.json> --json` (or the documented #1037 CLI sequence) with a secret-free request bound to the ship version and candidate. The request `base_branch` SHALL be the operator `TUGBOAT_BASE_BRANCH` when set, else the top-level `base_branch` from `.github/pipeline.yml` (the same source train and release use). It SHALL preserve slash-containing names such as `release/1.39`. It SHALL NOT guess `origin/HEAD` or take only the last path segment of a remote ref. When both the env override and the pipeline.yml source are unavailable, Tugboat SHALL fail before writing the request. The request `integrated_candidate.git_sha` SHALL be the current remote tip of the configured integration `base_branch` after train (via `origin/<base>` `ls-remote` or fetch, or injected `TUGBOAT_CANDIDATE_SHA`). It SHALL NOT default to the local checkout `HEAD`, which remains at the pre-train SHA when train merges through GitHub. Tugboat SHALL re-invoke the unchanged request until pack-done or pack-fail. Tugboat SHALL NOT start a second unbound pack and SHALL NOT implement a second pack runner. Tugboat SHALL NOT merge, tag, promote, or install in this phase. Tugboat SHALL NOT invent `pass: true`. Tugboat SHALL NOT persist the FRG key body in `state.json`.

The prepare child process SHALL have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset, even when the parent supervisor environment has one or both set. Tugboat SHALL NOT invoke prepare in an environment that still carries those variables.

When prepare returns `status: "awaiting_frg_attestation"`, or when unsigned eligible artifacts exist for the bound request and no matching `latest.json` `pass: true` exists, Tugboat SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a **separate** child process. `<loop>` SHALL be the bound pack `loop_run_id` from the prepare result (`loop_run_id` on `in_progress`, or `frg.loop_run_id` on `awaiting_frg_attestation`). That attestor child SHALL NOT pass `--observations`. That attestor child SHALL have the producer credential available to factory-gate: inherit `PIPELINE_FRG_ATTESTATION_KEY` when set, and when the supervisor supplied only `PIPELINE_FRG_ATTESTATION_KEY_FILE`, present that file's contents as `PIPELINE_FRG_ATTESTATION_KEY` in the attestor child only. Tugboat SHALL NOT run that attestor inside the prepare process.

Pack-done SHALL mean `.agent-pipeline/frg/<X.Y.Z>/latest.json` has `pass: true` and records the request `target_version` and `integrated_candidate.git_sha` (and `action_id` when the artifact records one), or prepare already returned `status: "complete"` with an open release PR for that version. Prepare JSON `status: "awaiting_frg_attestation"` alone SHALL NOT be pack-done. A `pass: true` artifact that lacks that binding, or that binds a different version or candidate SHA, SHALL NOT be pack-done; Tugboat SHALL re-invoke while prepare status is `in_progress`.

When `latest.json` has `pass: false` because HMAC was omitted, and the bound pack is structurally eligible, Tugboat SHALL treat that tick as `attest`. It SHALL NOT treat omitted-HMAC `pass: false` as pack-fail. `status: "awaiting_frg_attestation"` or unsigned eligible artifacts paired with that omitted-HMAC `pass: false` SHALL be `attest`. Tugboat SHALL NOT fail-close on `pass: false` before those attest signals. A signed `latest.json` `pass: false` SHALL be pack-fail only when that artifact is bound to the current request and the current prepare result is not `in_progress` with unsigned eligible artifacts. A prior candidate's signed `pass: false` SHALL NOT fail a current in-progress unsigned-eligible tick.

A `latest.json` `pass: false` caused by a real ineligible scoreboard (composition missing, required scenarios fail, wrong pack, engine-class over threshold) SHALL remain pack-fail. `status: "complete"` is pack-done only after an open release PR for that version is verified; a bare complete response with no open release PR is pack-fail. Pack-fail SHALL mean a failed or missing FRG status that is not omitted-HMAC-only, `latest.json` `pass: false` after a terminal **ineligible** score, attestor child failure or missing producer credential after unsigned artifacts exist, or wait-budget exhaustion while status stays `in_progress` **and the bound pack loop is not live**. Wait-budget exhaustion while status stays `in_progress` and the bound pack loop is live SHALL NOT be pack-fail. Unreadable or malformed `lock.json` or `ledger.json` SHALL NOT count as not-live. Tugboat SHALL keep re-invoking and heartbeat while liveness is unknown. The bound loop is not live only after a positive dead-or-missing lock pid and a positive terminal-or-missing ledger. On pack-fail Tugboat SHALL fail the frg-pack phase and SHALL NOT invoke `pipeline release` for that version.

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

#### Scenario: Stale signed failing latest.json does not fail a newer unsigned-eligible tick

- **WHEN** `.agent-pipeline/frg/1.39.5/latest.json` has `pass: false` with HMAC present bound to a prior candidate SHA
- **AND** prepare returns `status: "in_progress"` for a new request for version `1.39.5`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** the bound pack `loop_run_id` is `L`
- **AND** no matching `latest.json` `pass: true` exists for the new candidate
- **THEN** Tugboat SHALL classify that tick as `attest`
- **AND** it SHALL invoke `pipeline factory-gate --for 1.39.5 --from-run L` in a child process other than prepare
- **AND** it SHALL NOT fail the FRG pack phase on the stale signed `pass: false`

#### Scenario: Unsigned eligible omitted-HMAC pass false is attest

- **WHEN** prepare returns `status: "awaiting_frg_attestation"` for version `1.39.5`
- **AND** `.agent-pipeline/frg/1.39.5/latest.json` has `pass: false` because HMAC was omitted
- **AND** the bound pack is structurally eligible
- **AND** the bound pack `loop_run_id` is `L`
- **THEN** Tugboat SHALL classify that tick as `attest`
- **AND** it SHALL invoke `pipeline factory-gate --for 1.39.5 --from-run L` in a child process other than prepare
- **AND** that child SHALL have the producer credential
- **AND** Tugboat SHALL NOT fail the FRG pack phase on that `pass: false`

#### Scenario: Failed pack stops the ship before release

- **WHEN** prepare reports a failed or missing FRG status that is not omitted-HMAC-only
- **OR** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: false` after a terminal ineligible score
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for `1.39.0`

#### Scenario: Failed latest evidence blocks awaiting or complete

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` has `pass: false` because composition is missing or a required scenario failed
- **AND** prepare status is `complete`
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

#### Scenario: Live-loop wait expiry is not pack-fail

- **WHEN** prepare returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is live (`lock.json` pid alive or ledger not terminal)
- **AND** the numeric FRG wait attempt cap is exhausted
- **THEN** Tugboat SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done
- **AND** it SHALL NOT kill the pack loop

#### Scenario: Dead-loop wait expiry remains pack-fail

- **WHEN** prepare returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live (lock pid dead or missing, and ledger terminal or missing)
- **AND** the numeric FRG wait attempt cap is exhausted
- **THEN** Tugboat SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version

#### Scenario: Unreadable liveness at cap is not pack-fail

- **WHEN** prepare returns `status: "in_progress"` for bound loop `L`
- **AND** lock or ledger state for `L` is unreadable or malformed
- **AND** the numeric FRG wait attempt cap is exhausted
- **THEN** Tugboat SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT invoke `pipeline release` until pack-done

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

### Requirement: Tugboat SHALL export AGENT_PIPELINE_PRODUCTION_PIN to the factory pin

At process start, after Tugboat resolves `REPO_DIR`, Tugboat SHALL export
`AGENT_PIPELINE_PRODUCTION_PIN` when that variable is unset or empty. The exported
value SHALL be the factory pin file: the factory control checkout
`.agent-pipeline/production-engine-pin.json` (absolute path). Tugboat SHALL NOT
retarget the pin from session, model, or free-text overrides. An operator-set
`AGENT_PIPELINE_PRODUCTION_PIN` SHALL be left unchanged.

Default Tugboat `pipeline release` and `pipeline engine-promote` argv SHALL continue
to omit `--skip-frg` unless the logged-reason operator escape is active.

#### Scenario: Unset pin env is exported to the factory pin

- **WHEN** Tugboat starts a ship and `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** the Tugboat process environment SHALL contain
  `AGENT_PIPELINE_PRODUCTION_PIN` set to the factory control checkout
  `.agent-pipeline/production-engine-pin.json`
- **AND** the `engine-promote` child SHALL inherit that value

#### Scenario: Operator pin path is not overwritten

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is already set to `/custom/pin.json`
- **THEN** Tugboat SHALL leave that value unchanged

#### Scenario: Default promote argv still omits skip-frg

- **WHEN** Tugboat reaches engine-promote and the operator escape is not active
- **THEN** the promote invocation SHALL NOT include `--skip-frg`

### Requirement: Concurrent detach for one milestone SHALL admit exactly one ship

Tugboat SHALL serialize probe-and-spawn when two or more overlapping `tugboat --detach` invocations target the same milestone so that exactly one invocation detaches a ship and the others take the already-running / not-detaching path. Tugboat SHALL NOT emit more than one `detached tugboat ship` line for that overlapping set. Tugboat SHALL NOT leave two live detached tugboat/train ships for that milestone as a result of the race.

The live-ship probe from the existing live-ship definition remains the meaning of “already running.” Tugboat SHALL use a host-local admission lock to serialize the check. Presence of that lock or gate alone SHALL NOT constitute a live ship. After the winner detaches, a loser SHALL refuse by re-probing live ship (or an equivalent already-running report) and SHALL NOT spawn a second copy.

This requirement is host-local. It does not claim a cross-host ship mutex.

#### Scenario: Two overlapping detaches yield one ship

- **WHEN** no live ship exists for milestone `vX.Y.Z`
- **AND** two `tugboat --detach` processes for `vX.Y.Z` overlap in time
- **THEN** exactly one process SHALL emit `detached tugboat ship`
- **AND** exactly one live ship SHALL exist for `vX.Y.Z`
- **AND** the other process SHALL NOT emit `detached tugboat ship`
- **AND** the other process SHALL take the already-running / not-detaching path

#### Scenario: Both overlapping detaches exit successfully in the success fixture

- **WHEN** two overlapping `--detach` processes for the same milestone run in the success fixture (one winner, one loser)
- **THEN** both processes SHALL exit 0
- **AND** the combined output SHALL contain exactly one `detached tugboat ship` line
- **AND** the combined output SHALL contain exactly one already-running / not-detaching line

#### Scenario: Sequential second detach still uses the live-ship probe

- **WHEN** a live ship already exists for `vX.Y.Z`
- **AND** a later `--detach` for `vX.Y.Z` runs after the first ship is live
- **THEN** Tugboat SHALL refuse the second detach using the live-ship probe
- **AND** it SHALL NOT refuse solely because a detach gate or lock file exists
- **AND** bare `playbook.pid` + `kill -0`, a per-issue pipeline lock, and stale `state.json` SHALL still not constitute a live ship

### Requirement: Detach admission lock SHALL wait, re-probe, hold until live, and recover

Tugboat SHALL acquire a host-local admission lock atomically for the pair (repository-or-domain token derived from the pinned `REPO_DIR` realpath, milestone sanitized with `safe_of`) before probe-and-spawn. The lock path SHALL live under `PIPELINE_SUPERVISOR_STATE` (or the documented default state root) and SHALL NOT depend on the process working directory.

A process that does not acquire the lock immediately SHALL wait for release or a documented timeout, then re-probe live-ship status. Tugboat SHALL NOT treat lock-file presence, flock wait, or a leftover lock file as a live ship.

The winner SHALL hold the lock until the detached child is discoverable by `live_ship_probe` or the documented wait bound expires. Tugboat SHALL emit `detached tugboat ship` only after that probe succeeds. Tugboat SHALL NOT release the lock immediately after backgrounding the child.

Tugboat SHALL release the lock on normal return, error, and signal via `trap`. A stale lock whose owner process is dead, or a leftover lock file with no live flock holder, SHALL be recoverable. A crashed winner SHALL NOT permanently block a later `--detach`. If spawn fails or the wait-for-live bound expires with no live ship, Tugboat SHALL NOT emit `detached tugboat ship`. When a child was spawned, Tugboat SHALL track that child from spawn until live confirmation or successful cleanup, and SHALL terminate and reap that child, including any process group or session it created, before releasing the admission lock. EXIT, INT, and TERM cleanup SHALL reap any still-unconfirmed child before unlocking. Tugboat SHALL then release the lock and fail closed so a later `--detach` can proceed. An unconfirmed child SHALL NOT become a live ship after admission is released.

#### Scenario: Loser waits then refuses after the winner is live

- **WHEN** no live ship exists for `vX.Y.Z`
- **AND** two overlapping `--detach` processes compete for the same repo-token plus milestone lock
- **THEN** the loser SHALL wait for the winner to release the lock
- **AND** after acquire the loser SHALL re-probe with `live_ship_probe`
- **AND** the loser SHALL print the already-running / not-detaching path
- **AND** the loser SHALL NOT print `detached tugboat ship`
- **AND** the loser SHALL NOT treat the lock file itself as the refuse reason

#### Scenario: Stale admission artifact does not block sequential detach

- **WHEN** no live ship exists for `vX.Y.Z`
- **AND** a leftover admission lock file exists for that repo-token plus milestone
- **AND** the recorded owner is dead or absent and no live flock holder exists
- **THEN** a sequential `--detach` SHALL acquire admission
- **AND** it SHALL emit `detached tugboat ship`
- **AND** it SHALL NOT refuse solely because that lock file exists

#### Scenario: Failed spawn releases admission for a later detach

- **WHEN** a `--detach` acquires the admission lock
- **AND** spawn fails or the wait-for-live bound expires with no live ship
- **THEN** Tugboat SHALL NOT emit `detached tugboat ship`
- **AND** it SHALL release the admission lock
- **AND** a later `--detach` for the same repo-token plus milestone SHALL be able to acquire and detach

#### Scenario: Wait-for-live expiry reaps the unconfirmed child before release

- **WHEN** a `--detach` acquires the admission lock
- **AND** it spawns a child
- **AND** the wait-for-live bound expires before that child is a live ship
- **THEN** Tugboat SHALL NOT emit `detached tugboat ship`
- **AND** it SHALL terminate and reap the spawned child (including any process group that child created) before releasing the admission lock
- **AND** a later `--detach` for the same repo-token plus milestone SHALL be able to acquire and detach
- **AND** exactly one live ship SHALL exist after that later detach

#### Scenario: Signal during wait-for-live reaps the unconfirmed child before release

- **WHEN** a `--detach` acquires the admission lock
- **AND** it spawns a child
- **AND** it receives INT or TERM before that child is a live ship
- **THEN** Tugboat SHALL NOT emit `detached tugboat ship`
- **AND** it SHALL terminate and reap the spawned child (including any process group or session that child created) before releasing the admission lock
- **AND** a later `--detach` for the same repo-token plus milestone SHALL be able to acquire and detach
- **AND** exactly one live ship SHALL exist after that later detach

#### Scenario: Re-parented descendant is reaped before admission release

- **WHEN** a `--detach` acquires the admission lock
- **AND** it spawns a child
- **AND** that child forks a descendant into a new process group and exits before wait-for-live cleanup
- **AND** the wait-for-live bound expires with no live ship
- **THEN** Tugboat SHALL terminate and reap the re-parented descendant before releasing the admission lock
- **AND** a later `--detach` for the same repo-token plus milestone SHALL be able to acquire and detach
- **AND** exactly one live ship SHALL exist after that later detach

### Requirement: Concurrent detach regression SHALL stay enabled and fail closed

Automated checks SHALL keep a concurrent two-process `--detach` fixture for one milestone. That fixture SHALL spawn two detach processes and SHALL fail if both emit `detached tugboat ship`. The fixture SHALL NOT be deleted, skipped, or marked flaky. The fixture SHALL NOT treat a sleep-only race as the pass condition. Admission SHALL be serialized in the lock or probe, or the fixture SHALL wait on a documented lock or gate artifact before it asserts.

The fixture SHALL release both child processes through a deterministic start barrier or stub, wait for both exits, and inspect combined output. The fixture SHALL use a unique milestone coordinate so it does not collide with a live host ship or leftover stubs.

#### Scenario: Two detach lines fail the fixture

- **WHEN** the concurrent detach fixture runs
- **AND** both spawned processes emit `detached tugboat ship`
- **THEN** the fixture SHALL fail

#### Scenario: Fixture stays enabled

- **WHEN** an automated check inventory includes the concurrent detach fixture
- **THEN** that fixture SHALL still execute in the default `core` test run
- **AND** it SHALL NOT be skipped or marked flaky

#### Scenario: Fixture is not a sleep-only race

- **WHEN** the concurrent detach fixture asserts a single admission
- **THEN** the pass condition SHALL NOT be a sleep that hopes the second process sees the first
- **AND** either Tugboat SHALL have serialized admission before both processes can emit detach, or the fixture SHALL wait on a documented lock or gate artifact before it asserts

#### Scenario: Fixture uses a start barrier and waits for both exits

- **WHEN** the concurrent detach fixture runs
- **THEN** both child processes SHALL be released through a deterministic barrier or stub
- **AND** the fixture SHALL wait for both processes to exit
- **AND** it SHALL assert on the combined output of both processes
- **AND** it SHALL NOT treat scheduler interleaving alone as synchronization

### Requirement: Tugboat release-finish wait SHALL adopt the shared ship-release check-wait recipe

Tugboat SHALL apply the shared `ship-release-check-wait` classifier and bounded rerun recipe during the CI wait before `pipeline release finish`. Tugboat SHALL NOT implement a second divergent classify or rerun policy in the composer body. On classification `rerun`, Tugboat SHALL request `gh run rerun --failed` and resume the existing wait loop. On classification `fail`, Tugboat SHALL mark the release-finish phase failed and SHALL NOT invoke `pipeline release finish`.

#### Scenario: First flake-eligible test fail does not STOP Tugboat

- **WHEN** Tugboat’s wait helper classifies the release PR checks as `rerun`
- **AND** rerun budget remains
- **THEN** Tugboat SHALL request `gh run rerun --failed` for the failed run id
- **AND** it SHALL continue the wait loop
- **AND** it SHALL NOT write release-finish `failed` on that poll

#### Scenario: Shared helper is the only classify path

- **WHEN** an automated check inspects Tugboat’s release-finish wait
- **THEN** Tugboat SHALL invoke the shared wait helper for the checks capture
- **AND** it SHALL NOT treat a raw helper `-1` as immediate `exit 1` when the shared recipe still classifies `rerun`

### Requirement: Tugboat release-finish fail detail SHALL prefer the checks sidecar over leftover train warns

When Tugboat marks release-finish failed because the shared waiter classified `fail`, Tugboat SHALL enrich state and notify from the checks-fail sidecar (PR, check name, bucket or state, run URL, last failed test title when present). The lead reason SHALL NOT be a leftover `[pipeline] tester-evidence:` line or a `trusted-surface blocked` warn from an earlier train item.

#### Scenario: Release-finish STOP names the check URL

- **WHEN** Tugboat STOPs release-finish after a terminal `test` fail
- **AND** the checks sidecar includes an Actions run URL
- **THEN** the failed state/notify detail SHALL include that check name and run URL
- **AND** it SHALL NOT lead with `tester-evidence` or `trusted-surface blocked`

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

### Requirement: Tugboat FRG pack attestor isolation SHALL be regression-tested

Tugboat pack-phase isolation (uncredentialed prepare child, credentialed `factory-gate --from-run` attestor child, pack-done only on bound `latest.json` `pass: true`) SHALL be covered by automated checks that fail if:

- prepare is invoked with `PIPELINE_FRG_ATTESTATION_KEY` or `PIPELINE_FRG_ATTESTATION_KEY_FILE` set in that child,
- pack-done is declared for `awaiting_frg_attestation` without a matching `pass: true` `latest.json`,
- `in_progress` with unsigned eligible artifacts is classified as wait-only retry,
- unsigned eligible omitted-HMAC `pass: false` is classified as `fail`,
- `in_progress` with unsigned eligible artifacts is classified as `fail` because a prior candidate's signed `pass: false` remains in `latest.json`,
- prepare reports `failed` / `frg_not_eligible` when HMAC is the only missing piece,
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

#### Scenario: Regression fails if unsigned eligible pass false is classified fail

- **WHEN** the automated pack-isolation checks classify a tick whose prepare status is `awaiting_frg_attestation`
- **AND** `latest.json` has `pass: false` because HMAC was omitted
- **AND** the bound pack is structurally eligible
- **THEN** the checks SHALL print `attest`
- **AND** the checks SHALL fail if the classifier still prints `fail` for that tick

#### Scenario: Regression fails if stale signed pass false overrides current unsigned-eligible tick

- **WHEN** the automated pack-isolation checks classify a tick whose prepare status is `in_progress`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** `latest.json` has signed `pass: false` bound to a prior candidate SHA
- **THEN** the checks SHALL print `attest`
- **AND** the checks SHALL fail if the classifier still prints `fail` for that tick

#### Scenario: Regression fails if prepare reports failed for omitted HMAC only

- **WHEN** the automated prepare checks score a terminal structurally eligible pack without HMAC
- **THEN** the checks SHALL require `status: "awaiting_frg_attestation"`
- **AND** the checks SHALL fail if the result is `status: "failed"` or `defect_class: "frg_not_eligible"`

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

### Requirement: Tugboat FRG pack wait SHALL outlive the bound pack loop

Tugboat SHALL treat a factory-gate pack wait as wait-until-terminal while the bound pack loop is live, not as a CI-length poll. The bound pack loop is live when the durable loop run `lock.json` for the prepare `loop_run_id` has a pid that is still alive, or the bound loop ledger is not terminal. While prepare status is `in_progress` and that loop is live, Tugboat SHALL keep re-invoking the same `factory-release prepare` request, SHALL rewrite `state.json` with `phase` `frg-pack` and `status` `running` on each wait tick (heartbeat), SHALL log a heartbeat, and SHALL NOT apply the numeric FRG attempt cap as pack-fail. Unreadable or malformed `lock.json` or `ledger.json` SHALL NOT count as not-live. Tugboat SHALL keep re-invoking and heartbeat while liveness is unknown. The bound loop is not live only after a positive dead-or-missing lock pid and a positive terminal-or-missing ledger. Default FRG wait SHALL NOT copy the CI wait fail cap (`RELEASE_WAIT_ATTEMPTS` × `RELEASE_WAIT_SLEEP_S`, 30×40s) as the live-loop stop. A numeric FRG attempt cap MAY remain only for the not-live case. Tugboat SHALL NOT require a human re-detach to finish an in-progress pack. Tugboat SHALL NOT kill the pack loop. CI / release-PR check wait SHALL stay a CI poll.

A regression test SHALL fail if `in_progress` plus a live bound loop is classified as terminal fail after N short sleeps. Tests SHALL inject fixtures and SHALL NOT start a live pack.

#### Scenario: In-progress plus live loop continues after N short sleeps

- **WHEN** prepare status is `in_progress` for bound loop `L`
- **AND** `L` is live
- **AND** the wait decision is evaluated after N short sleeps at a numeric attempt cap of N
- **THEN** the decision SHALL be continue, not terminal fail
- **AND** an automated check SHALL fail if that case is classified as pack-fail

#### Scenario: In-progress plus unreadable liveness continues after N short sleeps

- **WHEN** prepare status is `in_progress` for bound loop `L`
- **AND** lock or ledger state for `L` is unreadable or malformed
- **AND** the wait decision is evaluated after N short sleeps at a numeric attempt cap of N
- **THEN** the decision SHALL be continue, not terminal fail
- **AND** an automated check SHALL fail if that case is classified as pack-fail

#### Scenario: State stays frg-pack running while the bound loop is live

- **WHEN** Tugboat is waiting on prepare `in_progress` for live bound loop `L`
- **THEN** `state.json` SHALL have `phase` `frg-pack` and `status` `running`
- **AND** `updated_at` SHALL advance on the wait heartbeat
- **AND** Buzz SHALL NOT observe `frg-pack` → `failed` for wait-budget expiry

#### Scenario: Re-detach is not required to finish a live pack

- **WHEN** a 2-item factory-gate pack is still `in_progress` after 20 minutes
- **AND** the bound loop is live
- **THEN** the same Tugboat process SHALL keep ticking prepare until pack-done or a real pack-fail
- **AND** it SHALL NOT require a human to re-detach Tugboat

#### Scenario: Default FRG wait is not the CI 20-minute fail cap

- **WHEN** an automated check inspects Tugboat FRG wait defaults
- **THEN** live-loop wait SHALL be wait-until-terminal (or hours-scale), not `FRG_WAIT_*` copied from `RELEASE_WAIT_*` as the live-loop stop
- **AND** the check SHALL fail if live `in_progress` still fails at 30×40s

### Requirement: Tugboat SHALL invoke candidate release ensure-tag before wait-release

After `pipeline release finish` returns success, Tugboat SHALL read `mergeCommitOid` from the finish JSON capture. If that field is missing or is not a 40-hex OID, Tugboat SHALL fail closed and SHALL NOT enter `wait-release`. Otherwise Tugboat SHALL invoke the recorded candidate CLI as `"${SHIP_END_CLI[@]}" release ensure-tag <X.Y.Z> <mergeCommitOid> --packed-candidate <SHIP_END_CANDIDATE_SHA>` where `SHIP_END_CANDIDATE_SHA` is factory-release request `integrated_candidate.git_sha`. A non-zero exit SHALL fail the ship before `wait-release`. Tugboat SHALL then poll `gh release view vX.Y.Z` as today. Tugboat SHALL NOT skip ensure-tag because auto-tag-release is configured. Tugboat SHALL NOT skip ensure-tag because the git tree has no `latest.json`. Tugboat SHALL NOT shell `git tag` or `gh release create`.

#### Scenario: Finish JSON merge commit drives ensure-tag

- **WHEN** `pipeline release finish` writes `mergeCommitOid` `M` for version `1.39.5`
- **AND** request `integrated_candidate.git_sha` is `C`
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** Tugboat SHALL invoke `"${SHIP_END_CLI[@]}" release ensure-tag 1.39.5 M --packed-candidate C`
- **AND** it SHALL NOT invoke `git tag`

#### Scenario: Missing mergeCommitOid fails before wait-release

- **WHEN** finish JSON has no 40-hex `mergeCommitOid`
- **THEN** Tugboat SHALL fail the ship
- **AND** it SHALL NOT poll `gh release view`

#### Scenario: Ensure-tag failure prevents wait-release

- **WHEN** candidate `release ensure-tag` exits non-zero
- **THEN** Tugboat SHALL fail the ship
- **AND** it SHALL NOT poll `gh release view`

#### Scenario: Pack-done plus merge without ensure-tag fails the composer check

- **WHEN** an automated Tugboat check inspects the post-finish path
- **AND** that path still goes from `release finish` success to `wait-release` with no `release ensure-tag`
- **THEN** the check SHALL fail

### Requirement: Tugboat ship-end CLI SHALL spawn Node major 24 or newer

Tugboat SHALL resolve the Node binary for `SHIP_END_CLI` to a binary whose `process.versions.node` major version is greater than or equal to 24. When `SHIP_END_NODE` is unset, or when it resolves to a major version below 24, Tugboat SHALL walk `PATH` for `node`, then try `/usr/bin/node` and `/usr/local/bin/node`, and SHALL use the first binary that meets the major-24 floor. Tugboat SHALL log the resolved path. Tugboat SHALL fail closed when no such binary exists. A systemd or host export of `SHIP_END_NODE` SHALL NOT be required for a passing ship.

#### Scenario: PATH node 22 yields /usr/bin/node 24

- **WHEN** `SHIP_END_NODE` is unset
- **AND** `PATH` `node` reports version `22.23.2`
- **AND** `/usr/bin/node` reports version `24.18.0`
- **THEN** Tugboat SHALL spawn `SHIP_END_CLI` with `/usr/bin/node`
- **AND** it SHALL NOT spawn the version-22 binary
- **AND** it SHALL log the resolved Node path

#### Scenario: PATH walk finds Node 24 after a failing default

- **WHEN** `SHIP_END_NODE` is `node` and that binary is major 22
- **AND** a later `PATH` directory contains a `node` binary whose major version is 24
- **THEN** Tugboat SHALL spawn `SHIP_END_CLI` with that major-24 binary

### Requirement: Tugboat ensure-tag SHALL pass repo-path to the candidate CLI

Tugboat `invoke_release_ensure_tag` SHALL invoke candidate `release ensure-tag` with `--repo-path "$REPO_DIR"` in addition to the version, merge-commit OID, and `--packed-candidate`. Tugboat SHALL fail closed when `REPO_DIR` is empty. Tugboat SHALL NOT omit repository identity so that `cfg.repo` empty cannot block observe.

#### Scenario: ensure-tag argv includes --repo-path

- **WHEN** Tugboat runs ensure-tag after release finish
- **AND** `REPO_DIR` is `/control`
- **THEN** the candidate argv SHALL include `--repo-path` and `/control`

### Requirement: Tugboat SHALL re-exec candidate tugboat.sh after train-complete

After train is complete or resumed complete and the candidate engine root is resolved, Tugboat SHALL exec `$SHIP_END_ENGINE_ROOT/examples/supervisor/shell/tugboat.sh` for FRG pack onward when the running script is not already that file. The re-exec SHALL set `TUGBOAT_SKIP_TRAIN=1` so train does not run again. Process-start `tugboat.sh` from a stale checkout SHALL NOT compose FRG pack, release, ensure-tag, or promote after that re-exec.

When `TUGBOAT_SKIP_TRAIN` is set, Tugboat SHALL skip `pipeline train` and continue when any of the following is true:

1. a non-empty `train.complete.json` exists in `RUN_DIR`, or
2. a non-empty `train.json` exists in `RUN_DIR`, or
3. `RUN_DIR` `state.json` or `train.stderr` records that train already resumed because the milestone has no open issues.

Tugboat SHALL fail closed only when none of those skip-train proofs exist. Tugboat SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact` on the empty-milestone resume path. Tugboat SHALL NOT require a human fast-forward of `REPO_DIR` for that path.

Before that `exec`, Tugboat SHALL export `PIPELINE_SUPERVISOR_STATE` (the same state root used to compute that ship `RUN_DIR`) and `REPO_DIR` so the candidate process reads the same ship artifacts. Tugboat SHALL NOT re-exec into a different state root when those values were already resolved for the process-start ship.

#### Scenario: Stale process-start tugboat does not compose FRG after train

- **WHEN** train merges a composer fix onto main at SHA `C`
- **AND** process-start `tugboat.sh` is an older tree
- **AND** the candidate engine root at `C` contains `examples/supervisor/shell/tugboat.sh`
- **THEN** Tugboat SHALL exec that candidate `tugboat.sh` before FRG pack
- **AND** the process-start script SHALL NOT invoke `factory-release prepare` after that exec

#### Scenario: Re-exec does not re-run train

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.complete.json` exists for that milestone
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack

#### Scenario: Skip-train accepts a non-empty complete artifact

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.complete.json` is non-empty
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`

#### Scenario: Skip-train accepts empty-milestone resume evidence without a complete file

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.json` is 0 bytes
- **AND** `train.complete.json` is absent
- **AND** `train.stderr` or `state.json` records that train resumed because the milestone has no open issues
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`
- **AND** it SHALL NOT require a human fast-forward of `REPO_DIR`

#### Scenario: Re-exec exports supervisor state and repo dir

- **WHEN** Tugboat execs candidate `tugboat.sh` after train-complete
- **AND** process-start `PIPELINE_SUPERVISOR_STATE` is `/state` and `REPO_DIR` is `/control`
- **THEN** the candidate process environment SHALL contain `PIPELINE_SUPERVISOR_STATE` set to `/state`
- **AND** it SHALL contain `REPO_DIR` set to `/control`
- **AND** skip-train SHALL read proof from `/state/ship-vX.Y.Z/` for that milestone
- **AND** it SHALL NOT recompute state under `$HOME/.local/state/pipeline-supervisor` when `/state` was already resolved

### Requirement: Tugboat HMAC-verify children SHALL present KEY_FILE as KEY

Tugboat children that verify Factory Reliability Gate HMAC SHALL present the producer credential using one recipe. Those children are the FRG pack attestor (`pipeline factory-gate --from-run`) and candidate `release ensure-tag`. The recipe SHALL be:

1. If `PIPELINE_FRG_ATTESTATION_KEY` is already set, inherit it and spawn with `env -u PIPELINE_FRG_ATTESTATION_KEY_FILE`.
2. Else if `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty, fail closed with named stderr reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
3. Else if that file is unreadable, fail closed with named stderr reason `unreadable_attestor_key_file` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
4. Else if that file is empty (`! -s`), fail closed with named stderr reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
5. Else spawn the HMAC-verify CLI with `PIPELINE_FRG_ATTESTATION_KEY` set to the file body (`cat --` of `PIPELINE_FRG_ATTESTATION_KEY_FILE`) and `env -u PIPELINE_FRG_ATTESTATION_KEY_FILE`.

Tugboat SHALL NOT leave HMAC verify without a credential when `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty file. Tugboat SHALL NOT persist the key body in `state.json`. Tugboat SHALL NOT require a human `env PIPELINE_FRG_ATTESTATION_KEY=…` wrap as the ship path.

#### Scenario: Ensure-tag presents KEY_FILE as KEY

- **WHEN** the supervisor environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** Tugboat invokes candidate `release ensure-tag` after `release finish`
- **THEN** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Ensure-tag inherits KEY and unsets KEY_FILE

- **WHEN** the supervisor environment sets `PIPELINE_FRG_ATTESTATION_KEY` to `inline-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is also set
- **AND** Tugboat invokes candidate `release ensure-tag`
- **THEN** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `inline-key`
- **AND** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Ensure-tag fails closed without a credential

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Ensure-tag fails closed on unreadable KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names an unreadable file
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `unreadable_attestor_key_file` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Ensure-tag fails closed on empty KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names a readable empty file
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Attestor and ensure-tag share the same KEY_FILE recipe

- **WHEN** the supervisor environment sets only `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file
- **AND** Tugboat invokes the FRG pack attestor child and later invokes candidate `release ensure-tag`
- **THEN** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to that file body
- **AND** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** Tugboat SHALL NOT require a human to export `PIPELINE_FRG_ATTESTATION_KEY` between those phases

### Requirement: Tugboat ensure-tag KEY_FILE mapping SHALL be regression-tested

Automated checks SHALL extract the real Tugboat ensure-tag HMAC-verify helper and the sibling FRG pack attestor helper from `examples/supervisor/shell/tugboat.sh`. With `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty dummy file, a fake ship-end CLI env recorder SHALL record ensure-tag child env `KEY=<dummy body>` and `KEY_FILE_UNSET`. Those checks SHALL fail if the ensure-tag child has neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE` in that fixture. Tests SHALL inject I/O or inspect extracted helpers. They SHALL NOT start a live tag push, network call, git, or subprocess ship.

#### Scenario: Regression fails if ensure-tag child has neither KEY nor KEY_FILE

- **WHEN** the automated ensure-tag credential checks run against a Tugboat helper that spawns `release ensure-tag` with `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** the parent supplied a readable non-empty `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** the child env records neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **THEN** the checks SHALL fail

#### Scenario: Regression records KEY from KEY_FILE and unsets KEY_FILE

- **WHEN** the automated ensure-tag credential checks run with `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty dummy file
- **THEN** the fake ship-end CLI env recorder SHALL contain `KEY=<dummy body>`
- **AND** it SHALL contain `KEY_FILE_UNSET`
}

### Requirement: Tugboat SHALL NOT bind a Hermes-state pin file as the default

Tugboat SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to `$REPO_DIR/.agent-pipeline/production-engine-pin.json` when that variable is unset or empty, even if `~/.local/state/hermes-factory/production-engine-pin.json` exists on the host. Tugboat SHALL NOT treat presence of that Hermes-state file as a reason to set the env to it. An already-set operator value SHALL still be left unchanged.

#### Scenario: Unset env binds control pin while Hermes-state file exists

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** `~/.local/state/hermes-factory/production-engine-pin.json` exists on the host
- **THEN** Tugboat SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** it SHALL NOT set the env to the Hermes-state path because that file exists

#### Scenario: Operator override remains unchanged

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is already set to `/custom/pin.json`
- **THEN** Tugboat SHALL leave that value unchanged

### Requirement: Tugboat MAY porcelain-clean fast-forward REPO_DIR to origin base

When `REPO_DIR` porcelain is empty, Tugboat MAY `git fetch` and fast-forward `REPO_DIR` to `origin/<base>` so process-start Tugboat matches the candidate. `<base>` SHALL be the same integration branch Tugboat already uses for the factory-release request (`TUGBOAT_BASE_BRANCH` when set, else `.github/pipeline.yml` `base_branch`). When porcelain is not empty, Tugboat SHALL NOT force-ff. A skipped or failed optional fast-forward SHALL NOT fail the ship. Tugboat SHALL NOT require a human `git merge --ff-only` as the product path.

#### Scenario: Clean checkout may fast-forward to origin base

- **WHEN** `REPO_DIR` `git status --porcelain` is empty
- **AND** `origin/<base>` is ahead of local `HEAD`
- **THEN** Tugboat MAY fetch and fast-forward `REPO_DIR` to `origin/<base>`
- **AND** it SHALL NOT fail the ship if it skips that fast-forward

#### Scenario: Dirty checkout is not force fast-forwarded

- **WHEN** `REPO_DIR` porcelain is not empty
- **THEN** Tugboat SHALL NOT run `git merge --ff-only` (or equivalent force-ff) on `REPO_DIR`
- **AND** it SHALL continue the ship without that fast-forward

### Requirement: Tugboat EXIT and RETURN lock release SHALL NOT dereference unbound lock_dir

Tugboat `ship_one` EXIT and RETURN lock-release traps SHALL NOT print `lock_dir: unbound variable` under `set -u`. Tugboat SHALL bind `lock_dir` before those traps run, or the release function SHALL no-op when `lock_dir` is unset. A successful ship SHALL still release the ship lock when `lock_dir` is bound.

#### Scenario: Successful ship EXIT does not print unbound lock_dir

- **WHEN** `ship_one` completes with phase status `ok`
- **AND** the EXIT trap runs under `set -u`
- **THEN** Tugboat SHALL NOT print `lock_dir: unbound variable`
- **AND** it SHALL NOT fail the ship solely because that trap ran

#### Scenario: Bound lock_dir is still released

- **WHEN** `ship_one` holds `RUN_DIR/lock` and `lock_dir` is bound
- **AND** the RETURN or EXIT trap runs
- **THEN** Tugboat SHALL release that lock directory

### Requirement: Empty-milestone skip-train and lock-release traps SHALL be regression-tested

Automated checks SHALL extract the real Tugboat helpers that write the train-complete artifact, decide skip-train, and release the ship lock from `examples/supervisor/shell/tugboat.sh`. Those checks SHALL fail on the v1.39.7 bodies:

- no-open-issues resume with empty `train.json` and missing `train.complete.json` does not write a non-empty complete artifact, then skip-train fails
- EXIT/RETURN lock release prints `lock_dir: unbound variable` under `set -u` after a successful ship

After the fix, the same extracted helpers SHALL write and accept a non-empty complete artifact, SHALL accept empty-milestone RUN_DIR resume evidence, and SHALL NOT print the unbound-variable error. Tests SHALL inject fixtures and SHALL NOT start a live train, network call, git, or subprocess ship.

#### Scenario: Regression fails if empty-milestone resume leaves no skip-train artifact

- **WHEN** the automated checks run the 1.39.7 resume helper with `train.json` of 0 bytes and no `train.complete.json`
- **AND** train stderr contains `has no open issues`
- **THEN** the checks SHALL fail if skip-train then fails for missing train artifact
- **AND** the checks SHALL fail if `train.complete.json` is still absent or 0 bytes

#### Scenario: Regression fails if EXIT trap prints unbound lock_dir

- **WHEN** the automated lock-release probe runs the 1.39.7 EXIT trap under `set -u` after `ship_one` locals are gone
- **THEN** the checks SHALL fail if stderr contains `lock_dir: unbound variable`

#### Scenario: Fixed helpers write and accept a complete artifact

- **WHEN** the automated checks run the fixed resume and skip-train helpers on the empty-milestone fixture
- **THEN** `train.complete.json` SHALL be non-empty
- **AND** skip-train SHALL accept that artifact (or RUN_DIR no-open-issues evidence)
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`

### Requirement: Spawn-real-tugboat skip-train re-exec fixtures SHALL leave proof and isolate parent skip-train env

Spawn-real-tugboat skip-train re-exec fixtures SHALL leave a skip-train proof in that ship `RUN_DIR` before the re-exec. Those fixtures spawn real `examples/supervisor/shell/tugboat.sh` and then re-exec the candidate composer with `TUGBOAT_SKIP_TRAIN=1`. Proof SHALL be a non-empty `train.complete.json`, or a non-empty `train.json`, or documented empty-milestone stderr / state as already accepted by skip-train. The shared FRG fixture writer and the candidate-engine spawn tests (#1151) SHALL do this.

Those fixtures SHALL NOT inherit parent `TUGBOAT_SKIP_TRAIN=1` or `TUGBOAT_CANDIDATE_COMPOSER` from the process environment unless the check is itself asserting skip-train. The first spawned process SHALL still run train (or fail closed for the original candidate / FRG reason). The checks SHALL still assert original FRG pack and candidate-engine behavior. They SHALL NOT be reduced to skip-train-only assertions.

The four v1.39.8 release-CI failures SHALL fail on current `main` without that isolation and proof when parent skip-train env is present, and SHALL pass with isolation and proof:

1. after train-complete, candidate argv records `factory-release` and pin argv records `train`
2. live `in_progress` at cap 1 keeps ticking prepare
3. not-live `in_progress` at cap 1 fails closed
4. unavailable candidate engine fails closed before pin `factory-release`

Tests SHALL inject fixtures and a fake pipeline. They SHALL NOT start a live train, network pack, git tag, or subprocess ship.

#### Scenario: Shared FRG fixture leaves skip-train proof before re-exec

- **WHEN** the shared FRG fixture spawns real `tugboat.sh`
- **AND** train is treated complete
- **AND** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **THEN** that ship `RUN_DIR` SHALL contain a skip-train proof before the re-exec
- **AND** the candidate composer SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`

#### Scenario: Parent skip-train env does not skip the fixture's own train

- **WHEN** the process environment has `TUGBOAT_SKIP_TRAIN=1` (a live Tugboat `pipeline release` child)
- **AND** a spawn-real-`tugboat.sh` fixture is not itself asserting skip-train
- **THEN** the spawned first process SHALL NOT inherit that skip-train flag
- **AND** it SHALL still invoke pin `train` (or fail closed for the original candidate / FRG reason)
- **AND** it SHALL NOT fail skip-train before those original assertions

#### Scenario: Four named tests keep original FRG and candidate assertions

- **WHEN** the four named #1150 / #1151 spawn-real-`tugboat.sh` tests run with isolation and proof
- **THEN** they SHALL still record candidate `factory-release` vs pin `train`, live-wait prepare ticks, not-live pack-fail, and unavailable-engine fail-closed
- **AND** they SHALL NOT pass solely because skip-train succeeded

#### Scenario: Regression fails on main without isolation and proof under parent skip-train env

- **WHEN** parent skip-train env is present as in v1.39.8 release CI
- **AND** the four named tests run against current `main` without isolation and without skip-train proof in `RUN_DIR`
- **THEN** those tests SHALL fail
- **AND** the failure text SHALL include `TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`

### Requirement: Tugboat SHALL launch bundled stage-watch with argv that script accepts

Tugboat SHALL invoke the default `SHIP_STAGE_WATCH_BIN` (the repo sibling `examples/supervisor/shell/ship-stage-watch.sh`, or an installed copy of that same contract) with an argv that script accepts when it starts optional per-issue stage posts during train. The product watch contract is `--events-file` only. Tugboat SHALL pass `--events-file` set to an absolute `events.jsonl` path taken from the live train/loop handoff (`kind: loop_run_handoff` field `events`, or equivalent). Tugboat SHALL NOT pass `--milestone` or `--since` while the bundled usage / argv parser documents `--events-file` and rejects `--milestone`. Tugboat SHALL NOT glob host-global run directories or select the newest `events.jsonl` by mtime. Tugboat SHALL start that watch in time to observe train stage events. Tugboat SHALL NOT wait until train has completed before attaching watch to a known live events path. Default `SHIP_STAGE_WATCH_BIN` SHALL remain that sibling contract. Installing an older `--milestone` binary on PATH SHALL NOT be required for Buzz stage posts.

#### Scenario: Train watch passes --events-file from the live handoff

- **WHEN** Tugboat enters the train phase for milestone `vX.Y.Z`
- **AND** `SHIP_STAGE_WATCH_BIN` is executable
- **AND** train emits a live `loop_run_handoff` whose `events` field is an absolute `events.jsonl` path
- **THEN** Tugboat SHALL invoke that binary with `--events-file` set to that absolute path
- **AND** it SHALL NOT pass `--milestone`
- **AND** it SHALL NOT pass `--since`

#### Scenario: Tugboat does not discover a latest run

- **WHEN** Tugboat starts stage-watch for a train
- **THEN** the `--events-file` argument SHALL be the live handoff absolute path
- **AND** Tugboat SHALL NOT search `~/.local/state/agent-pipeline` (or equivalent) for the newest `events.jsonl`

#### Scenario: Default watch binary is the repo sibling

- **WHEN** the operator has not set `SHIP_STAGE_WATCH_BIN`
- **THEN** Tugboat SHALL default it to the sibling `ship-stage-watch.sh` next to Tugboat
- **AND** Buzz stage posts SHALL NOT require `~/.local/bin/ship-stage-watch` on PATH

#### Scenario: Watch starts while train is still running

- **WHEN** Tugboat has the live handoff absolute `events` path during train
- **THEN** it SHALL spawn stage-watch with `--events-file` set to that path before train completes
- **AND** it SHALL NOT defer that spawn until after the train JSON capture is finished

### Requirement: Tugboat SHALL NOT claim a live stage-watch pid after argv reject

Tugboat SHALL log a named failure (`stage-watch argv rejected` or equivalent) when the bundled stage-watch exits non-zero on argv parse (including exit 2 for `unknown argument: --milestone`) or the spawn otherwise fails immediately. Tugboat SHALL NOT log `stage-watch started pid=…` for that spawn. Tugboat SHALL NOT treat a pid-file left by a dead watch process as proof the watch is live. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: --milestone reject is a named failure not a started pid

- **WHEN** Tugboat would spawn stage-watch with `--milestone`
- **AND** the bundled script exits 2 with `unknown argument: --milestone`
- **THEN** Tugboat SHALL log `stage-watch argv rejected` (or equivalent)
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn
- **AND** it SHALL NOT claim a live watch pid
- **AND** it SHALL still run `pipeline train`

#### Scenario: Successful watch may log started only after argv parse succeeds

- **WHEN** Tugboat spawns the bundled watch with accepted argv
- **AND** that process remains live after argv parse
- **THEN** Tugboat MAY log a started pid
- **AND** that pid SHALL match a process that did not exit non-zero on argv parse

### Requirement: Tugboat stage-watch argv SHALL be regression-tested against the bundled script

Automated checks SHALL extract the Tugboat train-phase stage-watch launch from `examples/supervisor/shell/tugboat.sh` and the bundled `examples/supervisor/shell/ship-stage-watch.sh` `usage` / argv parser. Those checks SHALL fail if Tugboat passes `--milestone` to the watch while the bundled usage / parser only documents `--events-file`. Tests SHALL inspect those sources (and MAY extract helpers). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on the v1.39.8 --milestone watch spawn

- **WHEN** the automated checks run against a Tugboat train watch launch that passes `--milestone`
- **AND** the bundled `ship-stage-watch.sh` usage / argv parser documents `--events-file` and does not accept `--milestone`
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when Tugboat passes --events-file

- **WHEN** the automated checks run against a Tugboat train watch launch that passes `--events-file` and does not pass `--milestone`
- **AND** the bundled usage / parser documents `--events-file`
- **THEN** the checks SHALL pass
