## ADDED Requirements

### Requirement: A successful loop drive SHALL emit an early machine-readable run handoff before first item dispatch

The CLI SHALL emit exactly one early run handoff for a successful drive after this process
holds the durable run's exclusive lock and before any per-item dispatch of this process
begins. The handoff applies when `pipeline loop` successfully creates or resumes a durable
run. The handoff SHALL be a single JSON object written to stdout, with `schema_version`
equal to the string `"1"` and `kind` equal to the string `"loop_run_handoff"`. The handoff
SHALL include at least: `run_id` (the durable loop run id), `run_dir` (absolute path to
that run's directory), `events` (absolute path to that run's `events.jsonl`), `engine` (the
acting engine), and `resumed` (whether this process attached with resume semantics). When a
selector was used to start or target the run, the handoff MAY include a `selector` summary;
when the run is addressed only by `--resume <run-id>`, `selector` SHALL be null or omitted.
The absolute paths SHALL be resolved through the durable loop store's state-home resolution
so they do not depend on the caller's working directory. The handoff SHALL be flushed to
stdout so a streaming consumer can observe it while the supervisor is still running. The
handoff SHALL NOT wait for the supervisor to reach a terminal condition.

#### Scenario: Fresh multi-item run advertises identity before first dispatch

- **WHEN** `pipeline loop` is invoked with a selector that successfully initializes or
  reattaches a durable run and acquires the exclusive lock
- **THEN** the CLI SHALL write one stdout JSON object with `kind` equal to
  `loop_run_handoff` containing the run's `run_id` and absolute `events` path
- **AND** that write SHALL complete before this process invokes per-item dispatch for any
  work-list item

#### Scenario: Resume also emits the early handoff

- **WHEN** `pipeline loop --resume <run-id>` successfully acquires the exclusive lock for
  an existing durable run
- **THEN** the CLI SHALL emit the early handoff for that `run_id` with `resumed` true
- **AND** the handoff SHALL complete before this process's first per-item dispatch

#### Scenario: Handoff paths are absolute store paths

- **WHEN** the early handoff is emitted
- **THEN** `run_dir` and `events` SHALL be absolute filesystem paths under the durable loop
  store's resolved state home for that run
- **AND** a consumer SHALL be able to open `events` without knowing the caller's cwd or
  recomputing state-home precedence

#### Scenario: Handoff is flushed for streaming consumers

- **WHEN** the early handoff JSON line is written
- **THEN** the CLI SHALL flush that line to stdout rather than leaving it only in a
  user-space buffer
- **AND** a consumer reading the pipe before the process exits SHALL be able to parse the
  handoff without waiting for the terminal summary

---

### Requirement: The early handoff SHALL be distinguishable from the terminal loop summary and from failure output

The early handoff SHALL be identified by `kind: "loop_run_handoff"`. The existing terminal
drive summary JSON emitted when the supervisor returns SHALL NOT use
`kind: "loop_run_handoff"`. A harness SHALL be able to select the handoff by parsing JSON
lines and matching that kind, without scraping human-readable prose on stderr. Human
stderr lines MAY mention the run id or events path for operators but SHALL NOT be the
sole handoff contract.

#### Scenario: Kind discriminator selects the handoff

- **WHEN** a successful multi-item drive emits both the early handoff and later the
  terminal summary on stdout
- **THEN** exactly one stdout JSON object SHALL carry `kind` equal to `loop_run_handoff`
- **AND** the terminal summary SHALL remain parseable by its existing fields and SHALL NOT
  carry `kind` equal to `loop_run_handoff`

#### Scenario: Prose is not required for discovery

- **WHEN** a harness reads only machine-readable stdout JSON from a successful drive
- **THEN** it SHALL obtain `run_id` and the absolute `events` path from the handoff object
  alone
- **AND** it SHALL NOT need to parse stderr text to discover those values

---

### Requirement: Failure and read-only paths SHALL NOT emit a successful early handoff

Preflight failures, selector/config/init/lock failures, and `--audit` mode SHALL NOT emit a
JSON object with `kind: "loop_run_handoff"`. Those paths SHALL keep their existing
contracts: non-zero exit with remediation on failure; read-only audit report on `--audit`
with no durable mutation. Emitting the handoff SHALL NOT introduce durable writes beyond
those the successful create/lock path already performs.

#### Scenario: Preflight failure emits no handoff

- **WHEN** `pipeline loop` fails preflight (argument normalization, store schema
  compatibility, or native-goal capability)
- **THEN** the command SHALL exit non-zero with remediation
- **AND** it SHALL NOT write a `loop_run_handoff` JSON object to stdout
- **AND** it SHALL perform zero durable loop-store writes beyond existing preflight
  contracts

#### Scenario: Lock held by another process emits no handoff

- **WHEN** `pipeline loop` targets a run whose exclusive lock is held by another process
  and acquisition fails
- **THEN** the command SHALL exit non-zero naming the lock conflict
- **AND** it SHALL NOT emit `kind: "loop_run_handoff"`

#### Scenario: Audit mode stays read-only and handoff-free

- **WHEN** `pipeline loop --audit --resume <run-id>` succeeds
- **THEN** the command SHALL print the audit report only
- **AND** it SHALL NOT emit `kind: "loop_run_handoff"`
- **AND** it SHALL perform no durable mutation (no lock acquisition for drive, no ledger
  write, no event append attributable to a drive handoff)

---

### Requirement: Unit and CLI tests SHALL prove handoff shape, ordering, and non-emission on failure

The handoff behavior SHALL be covered by unit or CLI tests that inject I/O through
dependency seams and perform no real network, git, or subprocess calls. Coverage SHALL
include: the required JSON fields and `kind` value; emission before the first mocked
dispatch; resume emission; and non-emission on preflight failure and on lock failure. At
least one regression assertion SHALL fail against the pre-change behavior that only
surfaced `run_id` in the terminal summary after the supervisor completed.

#### Scenario: Regression bites without the early handoff

- **WHEN** the handoff regression test runs against an implementation that only prints
  `run_id` in the terminal summary after drive completion
- **THEN** the test SHALL fail
- **AND** when the early handoff is implemented per this capability the same test SHALL
  pass

#### Scenario: Tests use dependency seams only

- **WHEN** the handoff unit/CLI tests execute
- **THEN** they SHALL drive the command through injected preflight/engine/dispatch (or
  equivalent) seams
- **AND** they SHALL perform no real network, git, or subprocess calls
)
