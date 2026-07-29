## ADDED Requirements

### Requirement: `pipeline loop` SHALL surface an early run handoff on the facade drive path

The `pipeline loop` / `pipeline:loop` facade SHALL surface the early machine-readable run
handoff defined by capability `loop-early-run-handoff` on the drive path after a successful
preflight and a successful create-or-resume plus exclusive lock of the durable run, and
before the first item dispatch of that process. The facade SHALL NOT delay that handoff
until the supervisor terminal condition. The facade SHALL continue to emit the existing
terminal drive summary when the supervisor returns, and SHALL continue to refuse preflight
failures with non-zero exit, remediation, and zero external mutation. `--audit` SHALL remain
read-only and SHALL NOT emit the drive handoff.

#### Scenario: Facade drive path exposes handoff before dispatch

- **WHEN** `/pipeline:loop` or `$pipeline:loop` (or `pipeline loop`) successfully starts or
  resumes a durable multi-item run
- **THEN** the facade's CLI process SHALL emit the early `loop_run_handoff` JSON on stdout
  before the first per-item dispatch
- **AND** the same process SHALL still emit the terminal drive summary when the run reaches
  a terminal condition

#### Scenario: Facade failure path still mutates nothing and emits no handoff

- **WHEN** the facade preflight fails
- **THEN** the command SHALL exit non-zero with remediation
- **AND** it SHALL emit no `loop_run_handoff`
- **AND** it SHALL leave no lock, ledger write, or GitHub mutation attributable to a drive

---

### Requirement: Host packaging for `pipeline:loop` SHALL NOT claim multi-item runs complete in seconds without progress follow

Host packaging for `pipeline:loop` SHALL NOT claim that a multi-item durable loop drive
“completes in seconds” or that “No Monitor” / no progress follow is needed for that drive.
The claim applies to Claude and Codex command surfaces generated from the shared operation
list. Packaging SHALL state that a successful drive emits an early machine-readable handoff
containing `run_id` and the absolute `events` path so an operator or harness can follow
structured progress for the wall-clock duration of the run. Short-lived modes that remain
short-lived (`--audit` when it only prints a report) MAY still be described as fast,
provided they are not conflated with the multi-item drive path.

#### Scenario: Command surface no longer denies progress follow for multi-item drive

- **WHEN** the generated `pipeline:loop` command documentation on either host is inspected
- **THEN** it SHALL NOT claim that multi-item durable drive completes in seconds with no
  Monitor or progress follow needed
- **AND** it SHALL mention the early handoff's `run_id` and events path as the way to
  follow progress

#### Scenario: Both hosts stay aligned

- **WHEN** the Claude and Codex packaging for `pipeline:loop` are compared after the change
- **THEN** neither host SHALL reintroduce the false “completes in seconds / No Monitor
  needed” claim for multi-item durable drive
- **AND** both SHALL describe the same early-handoff progress-follow contract
)
