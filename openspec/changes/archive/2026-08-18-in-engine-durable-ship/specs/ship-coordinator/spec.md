## MODIFIED Requirements

### Requirement: The CLI SHALL provide one explicit ship coordinator

The CLI SHALL expose `pipeline ship --milestone vX.Y.Z` as the operator product command. When the milestone title is a semantic version (`vX.Y.Z` or `X.Y.Z`), the coordinator SHALL derive the release version from that title and SHALL NOT require a separate `--for` flag. It SHALL compose the existing integrated train in merge mode, bounded Pipeline recovery, candidate-bound FRG validation, release prepare and finish, publication verification, and `engine-promote`. It SHALL NOT reimplement stage dispatch, merge gates, FRG scoring, release mutation, retry taxonomy, or install behavior.

The command SHALL remain loop-isolated: `advance`, `single`, and `loop` SHALL never invoke it. Operator invocation of `pipeline ship --milestone` SHALL be sufficient authority to compose those existing loop-isolated surfaces. The command SHALL NOT require `--authorization` or a signed grant document.

The coordinator SHALL execute this phase order for a semver milestone: `train --merge` → (semver) `release` → wait until the release PR checks are green → `release finish` → wait until GitHub Release `vX.Y.Z` is published → `engine-promote`. It SHALL NOT invent a second merge policy.

#### Scenario: One command composes existing lifecycle utilities

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3`
- **THEN** the coordinator SHALL call the existing Pipeline implementations for each lifecycle phase
- **AND** it SHALL NOT create a second issue scheduler, merge implementation, FRG scorer, release builder, or model router

#### Scenario: Milestone-only argv does not require a grant document

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3` with no `--authorization` and no `--for`
- **THEN** the command SHALL admit and compose the ship phases
- **AND** it SHALL NOT exit for a missing grant file or a missing `--for`

#### Scenario: Advance surfaces do not acquire ship authority

- **WHEN** `pipeline advance`, `pipeline single`, or `pipeline loop` reaches
  `pipeline:ready-to-deploy`
- **THEN** it SHALL still stop without invoking the ship coordinator

---

### Requirement: Ship state SHALL be typed, atomic, and restart-safe

The coordinator SHALL persist one atomic typed state record keyed by repository,
base branch, and milestone (and version when distinct from the milestone title).
The record SHALL include at least `schema_version`, `kind`, repository, base,
milestone, version, phase, current item, last durable stage, exact child run
identities, current candidate identity, release PR identity when known, a
human-authority flag when the current stop is human authority, and terminal
result when known. It SHALL treat GitHub and Pipeline artifacts as authoritative
and use the record only as a restart checkpoint.

Before each external mutation, including after process restart, it SHALL
re-observe the relevant issue, PR, base, FRG, publication, pin, and installed
engine state. A completed observation SHALL advance the checkpoint without
repeating the mutation. Ambiguous or mismatched identity SHALL fail closed.
The coordinator SHALL resolve and atomically store the ordered milestone issue
plan before the first train mutation. A restart SHALL reuse that exact plan;
later milestone assignments SHALL NOT widen the accepted shipment.

A second invoke of the same repository, base, and milestone SHALL continue this
record. It SHALL NOT start a sibling plan or implement while an earlier
`pipeline:ready-to-deploy` item on that plan still has an open mergeable PR.

#### Scenario: Restart after an external side effect reconciles

- **WHEN** the process stops after a train merge, release PR creation, release
  merge, publication, pin update, or install but before the next checkpoint
- **THEN** a restart SHALL observe the completed side effect and continue
- **AND** it SHALL NOT perform the same mutation twice

#### Scenario: Candidate drift fails closed

- **WHEN** the observed release PR head, base, or release version differs from
  the typed prepare identity stored by the ship
- **THEN** the coordinator SHALL stop with a typed identity error before merge

#### Scenario: Later milestone assignment does not widen the ship

- **WHEN** the coordinator has stored its ordered issue plan
- **AND** another issue is later assigned to the same GitHub milestone
- **THEN** a restart SHALL continue only the stored issue plan
- **AND** it SHALL NOT merge the later issue under the accepted shipment

#### Scenario: Second invoke does not farm a sibling while an R2D PR is open

- **WHEN** the ship ledger records item A at `pipeline:ready-to-deploy` with an open mergeable PR
- **AND** an operator re-invokes `pipeline ship --milestone` for the same milestone
- **THEN** the coordinator SHALL continue the same ledger and SHALL merge A (via `train --merge`) before any plan or implement of a newer sibling
- **AND** it SHALL NOT implement a newer sibling while that PR remains open

---

### Requirement: Host adapters SHALL use systemd only for process supervision

Host adapters SHALL map operator phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`.
Hermes, OpenClaw, Claude, Codex, Grok, omp, OpenCode, and other hosts use that same mapping.
If the CLI is blocking, the adapter MAY detach one process (systemd user unit or
the host’s existing detach helper) without waiting for terminal completion.
The adapter SHALL render typed `pipeline ship status` plus material-filtered
exact-run events. Pipeline SHALL hold one host-local writer lock for each
repository/base across foreground and detached calls. systemd or the detach
helper MAY own process restart, PID tracking, cancellation, logs, and service
lifetime.

The adapter SHALL NOT implement its own durable scheduler, PID registry,
lifecycle state machine, merge policy, release discovery, retry policy,
classification, run-directory janitor, or event attribution. On notify of a
non-human failure it SHALL re-invoke the same `pipeline ship --milestone …`
argv. If ship status reports human authority, it SHALL stop and report that
state. It SHALL NOT invent `single` or `loop`.

#### Scenario: Accepted command returns after admission

- **WHEN** an operator issues `Ship milestone v1.39.3` on a configured host
- **THEN** the adapter SHALL exec `pipeline ship --milestone v1.39.3` (detached when the CLI is blocking) and return an accepted response without waiting for the ship to finish
- **AND** subsequent progress SHALL come from typed ship status and exact-run material events

#### Scenario: systemd restart resumes one ship

- **WHEN** the ship process exits unexpectedly and systemd or the host detach helper restarts its unit
- **THEN** the same milestone coordinates SHALL resume the same Pipeline ship record
- **AND** the adapter SHALL NOT create a parallel wrapper-local run

#### Scenario: Hermes re-invokes the same ship on non-human failure

- **WHEN** ship status or notify reports a non-human failure for milestone `v1.39.3`
- **THEN** Hermes SHALL re-invoke `pipeline ship --milestone v1.39.3`
- **AND** it SHALL NOT classify the failure, delete a run directory, wait a cooldown, or invoke `pipeline single` / `pipeline loop`

#### Scenario: Human-authority ledger stops the host

- **WHEN** ship status reports a human-authority stop for the milestone
- **THEN** the host SHALL stop and report that human-authority state
- **AND** it SHALL NOT re-invoke ship as if the stop were a dead-holder interrupt

## ADDED Requirements

### Requirement: Ship interrupt with a dead holder SHALL resume the same item

The coordinator SHALL treat a dead harness, SIGTERM, host reboot, or network drop mid-stage as a resume-eligible interrupt when the prior holder is dead. It SHALL continue the same ledger item from its last durable stage using the worktree, live labels, and ship ledger. It SHALL NOT classify that interrupt as `workflow-engine-defect`. It SHALL NOT burn a `restart_workflow_engine` class budget. It SHALL NOT STOP the ship with `supervisor_no_progress` solely because the prior holder is dead.

#### Scenario: Kill mid-implement resumes the same issue

- **WHEN** ship is implementing issue N for milestone `vX.Y.Z`
- **AND** the implementer process is killed and the prior holder is dead
- **AND** an operator re-invokes `pipeline ship --milestone vX.Y.Z`
- **THEN** ship SHALL resume issue N from its last durable stage
- **AND** it SHALL NOT STOP with `supervisor_no_progress`
- **AND** it SHALL NOT record a leftover `workflow-engine-defect` whose first recipe was `restart_workflow_engine`

### Requirement: Ship SHALL fail when merge-first is violated

When the composed `train --merge` would plan or implement any milestone item while a work-list item already at `pipeline:ready-to-deploy` still has an open mergeable PR, the ship SHALL fail closed. The first mutation of a ship or merge-mode train that observes ready-to-deploy #A with an open MERGEABLE PR and ready #B SHALL be the merge of #A.

#### Scenario: Open R2D PR blocks sibling implement

- **WHEN** item A is `pipeline:ready-to-deploy` with an open MERGEABLE PR
- **AND** item B is `pipeline:ready` on the same milestone
- **THEN** ship SHALL merge A and prove base containment before any plan or implement of B
- **AND** a fixture that implements B first SHALL fail
