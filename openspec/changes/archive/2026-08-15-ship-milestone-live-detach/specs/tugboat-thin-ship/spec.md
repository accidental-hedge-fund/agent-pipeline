## ADDED Requirements

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
