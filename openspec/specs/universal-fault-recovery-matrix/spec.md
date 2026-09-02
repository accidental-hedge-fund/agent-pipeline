# universal-fault-recovery-matrix Specification

## Purpose
Defines the executable production-shaped fault and state matrix that proves unknown errors and inconsistent states reach one recovery owner, and that obsolete command-local terminal paths cannot return.

## Requirements

### Requirement: One executable matrix SHALL declare operation, fault/state, public-entrypoint, and host dimensions

The pipeline SHALL maintain one executable fault-and-state matrix inventory that declares the dimensions operation, fault/state, public entry point, and host. Each cell SHALL name its FRG lifecycle class, coverage layer, covering proof or a checked `not_applicable` reason, and expected unique-operation terminal. Adding a dimension value without a covering row or a checked `not_applicable` reason SHALL create a failing uncovered cell. The inventory SHALL feed existing unique-operation coverage counts. The pipeline SHALL NOT add a second Factory Reliability Gate (FRG) runner, RecoverySupervisor, scheduler, or public fault-matrix command.

#### Scenario: Missing required cell fails the inventory guard

- **WHEN** a required fault/state class has no covering row and no checked `not_applicable` reason
- **THEN** the matrix inventory guard SHALL fail
- **AND** the failure SHALL name the missing class and dimension values

#### Scenario: New dimension value without coverage fails

- **WHEN** a new public entry point, host, supervised operation, or fault/state class is added to a required dimension
- **AND** no covering row and no checked `not_applicable` reason exist for that value
- **THEN** the inventory guard SHALL fail
- **AND** FRG promotion SHALL treat the gap as missing required coverage, not as a stable exclusion

#### Scenario: Checked not_applicable cell is accepted

- **WHEN** a cell cannot occur (for example continuous ship × a SemVer-only phase, or a host that cannot launch a verb)
- **AND** the row records a closed `not_applicable` reason
- **THEN** the inventory guard SHALL accept that cell
- **AND** SHALL NOT count it as covered lifecycle proof
- **AND** SHALL NOT count it as missing required coverage

---

### Requirement: The matrix fault/state dimension SHALL cover every required lifecycle class member

The matrix fault/state dimension SHALL include exception, rejection, nonzero exit, signal, timeout, malformed or contradictory output, interrupted or uncertain side effect, stale or corrupt durable state, event or ledger partial writes, candidate movement, remote mutation, dependency cycle, no progress, clock or lease ambiguity, unavailable harness, observer failure, unseen provider error shape, process death at each side-effect boundary, and strategy exhaustion. Those members SHALL map to the existing FRG lifecycle classes `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown`. Known GitHub, CI, conflict, auth, and worktree incidents SHALL appear only as fixtures inside those generic classes. Production routing SHALL NOT switch on incident titles, provider names, or HTTP-string keys.

#### Scenario: Required fault/state members are inventoried

- **WHEN** the matrix inventory is inspected
- **THEN** it SHALL contain a row or checked `not_applicable` reason for each required fault/state member
- **AND** each member SHALL map to exactly one of `mechanical`, `workflow`, `infrastructure`, `authentication`, or `unknown`

#### Scenario: Named incident is a fixture, not a dispatch key

- **WHEN** a GitHub, CI, conflict, auth, or worktree incident is used in a matrix row
- **THEN** the row SHALL classify that incident under a generic fault/state class
- **AND** production recovery routing SHALL NOT contain that incident title or provider string as a dispatch key

#### Scenario: Unseen provider error shape is unknown, not human

- **WHEN** an adapter reports an error shape that no current classifier recognizes
- **THEN** the matrix row SHALL cover that input as the `unknown` lifecycle class
- **AND** the outcome SHALL NOT be a False-human projection
- **AND** the outcome SHALL NOT be an Ownerless terminal

---

### Requirement: Matrix coverage SHALL have adapter-contract, installed-CLI, and host-conformance layers

Matrix coverage SHALL have three layers: adapter contracts, installed-CLI black-box entry points, and host conformance. Adapter-contract tests SHALL inject faults at the operation-adapter seam with no real network, git, or subprocess, and SHALL prove the observation reaches the sole RecoverySupervisor without the adapter declaring the run terminal. Installed-CLI black-box tests SHALL drive the installed `pipeline` CLI for numeric drive, `single`, `loop`, `train`, `merge`, merge queue, `ship`, and every supervised disposition from the operation inventory. Host-conformance tests SHALL reuse the existing outer-host conformance kit and SHALL compare typed lifecycle outcomes, not prompt text. Island unit tests and `#740` hidden eval fixtures SHALL NOT satisfy installed-CLI or host-conformance coverage. FRG promotion SHALL require 100% of required lifecycle classes across the applicable layers.

#### Scenario: Adapter contract proves supervisor ingress

- **WHEN** an adapter-contract fixture injects an exception, rejection, nonzero exit, signal, timeout, or malformed output
- **THEN** the test SHALL record a typed operation observation
- **AND** the adapter SHALL NOT declare the overall run terminal
- **AND** the test SHALL perform no real network, git, or subprocess call

#### Scenario: Installed-CLI black-box covers public entry points

- **WHEN** the installed-CLI layer runs
- **THEN** it SHALL exercise numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship`
- **AND** it SHALL exercise every supervised disposition from the operation inventory
- **AND** island unit tests alone SHALL NOT mark that layer covered

#### Scenario: Hidden evals are not production lifecycle proof

- **WHEN** a `#740` hidden eval fixture exists for restart or partial failure
- **THEN** the matrix inventory SHALL NOT register that fixture as covering proof for a required lifecycle class
- **AND** FRG promotion SHALL still require matrix rows on the three coverage layers

#### Scenario: Missing required lifecycle class fails FRG promotion

- **WHEN** a required FRG lifecycle class has no covering matrix row for an applicable layer
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

---

### Requirement: Mechanical matrix fixtures SHALL remain owned without human projection or supervisor STOP

Every mechanical matrix fixture SHALL end as durable Cooling or recovery, an external-condition wait, or a valid typed request. The fixture SHALL NOT produce a False-human projection, an Ownerless terminal, or a terminal supervisor STOP. A fresh-process restart SHALL NOT replay a side effect whose certainty is known complete. Workflow continuation SHALL occur only after the target invariant is proven against the authoritative observer. Genuine decision, capability, and authority fixtures SHALL stop before unauthorized action.

#### Scenario: Mechanical fixture has no false-human and no ownerless terminal

- **WHEN** a mechanical fault/state fixture runs on a public entry point
- **THEN** unique-operation false-human count for that fixture SHALL be 0
- **AND** ownerless-terminal count for that fixture SHALL be 0
- **AND** the supervisor SHALL NOT STOP the run solely for that mechanical fault

#### Scenario: Fresh-process restart does not replay a completed side effect

- **WHEN** a fixture records a side effect as known complete
- **AND** a fresh process resumes the same logical operation
- **THEN** the completed side effect SHALL NOT be replayed
- **AND** verified completion SHALL still count once on the original logical operation

#### Scenario: Uncertain side effect is reconciled before continuation

- **WHEN** a fixture records a side effect as uncertain
- **THEN** the supervisor SHALL reconcile against the authoritative observer before replay
- **AND** workflow continuation SHALL occur only after the target invariant is proven

#### Scenario: Authority fixture stops before unauthorized action

- **WHEN** a genuine Authority Request, Capability Request, or Decision Request fixture is current
- **THEN** the operation SHALL stop in that typed request
- **AND** SHALL NOT perform the unauthorized mutation

---

### Requirement: The matrix SHALL cover both ship models without treating missing SemVer phases as a gap

The matrix SHALL include rows for both `#1024` ship models `semver` and `continuous`. Under `continuous`, absence of SemVer-only phases SHALL be a checked `not_applicable` reason and SHALL NOT be missing required coverage. Under `semver`, the corresponding phase rows SHALL be required. The matrix SHALL NOT invent a second ship coordinator.

#### Scenario: Continuous ship marks SemVer-only phases not_applicable

- **WHEN** `roadmap.release_model` is `continuous`
- **AND** a cell names a SemVer-only release phase
- **THEN** that cell SHALL record a checked `not_applicable` reason
- **AND** FRG SHALL NOT treat that absence as missing required coverage

#### Scenario: SemVer ship requires phase rows

- **WHEN** `roadmap.release_model` is `semver`
- **AND** a required SemVer ship-phase fault/state cell has no covering row
- **THEN** the inventory guard SHALL fail
- **AND** FRG promotion SHALL fail for missing required coverage

---

### Requirement: Installed-host matrix rows SHALL cover every supported host

The matrix host dimension SHALL include every builtin registered outer host and direct CLI. Hermes and OpenClaw SHALL remain example-supervisor conformance fixtures. They SHALL NOT be silently promoted to shipped hosts. Unsupported host capability SHALL become a typed Capability Request. Host rows SHALL compare typed lifecycle outcomes, not prompt text.

#### Scenario: Builtin hosts have parity rows

- **WHEN** the host dimension is inspected
- **THEN** it SHALL include `claude`, `codex`, `grok`, `opencode`, `omp`, and direct CLI
- **AND** each SHALL have covering rows or checked `not_applicable` reasons for required fault/state classes

#### Scenario: Hermes and OpenClaw stay example fixtures

- **WHEN** Hermes or OpenClaw appears in the matrix
- **THEN** the row SHALL be an example-supervisor conformance fixture or checked `not_applicable`
- **AND** install and generated host packaging SHALL NOT treat that host as a shipped builtin

---

### Requirement: Legacy command-local lifecycle paths SHALL be removed only after replacement rows pass

The pipeline SHALL delete obsolete command-local retry, recovery, parking, and STOP implementations only after the replacement matrix row for that class and entry point passes. Static guards SHALL reject direct stage lifecycle writes from command modules, command-local lifecycle exits on supervised mutations, and imports of retired recovery controllers. Production routing SHALL contain no incident or provider string keys.

#### Scenario: Replacement row precedes deletion

- **WHEN** a command-local STOP or retry path still exists
- **AND** the replacement matrix row for that class and entry point has not passed
- **THEN** the deletion SHALL NOT proceed
- **AND** the inventory SHALL still list that path as uncovered or legacy-pending

#### Scenario: Retired controller import fails the static guard

- **WHEN** production code imports a retired command-local recovery controller
- **THEN** a static guard test SHALL fail
- **AND** the failure SHALL name the import

#### Scenario: Command-local lifecycle exit fails the static guard

- **WHEN** a supervised lifecycle command exits through a command-local `process.exit` on a mechanical fault
- **THEN** a static guard test SHALL fail
- **AND** the mechanical fault SHALL instead be an operation observation for RecoverySupervisor

#### Scenario: Provider string dispatch fails the static guard

- **WHEN** production recovery routing contains a provider name or incident title as a dispatch key
- **THEN** a static guard test SHALL fail
