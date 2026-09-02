## MODIFIED Requirements

### Requirement: The pipeline SHALL support an opt-in run-start preflight that blocks the run on failure

When `doctor.runOnStart: true` is set in config or `--doctor` is passed on the CLI, the pipeline SHALL run the preflight checks before the planning stage begins. If any check fails, the pipeline SHALL print the doctor summary and SHALL NOT enter the planning stage. No planning, implementation, or review tokens SHALL be consumed when the run-start preflight fails. That failure SHALL be reported as a RecoverySupervisor operation observation, or as a typed Capability Request when the failing check is an unavailable external capability, condition, or information. The Logical Operation SHALL remain owned (Cooling or an external-condition wait). The CLI MAY return a non-zero process status as a compatibility projection. That status SHALL NOT be ownerless STOP and SHALL NOT be implemented as a silent raw `process.exit(1)` that ends recovery ownership. Standalone `pipeline doctor` SHALL remain a read-only diagnostic and MAY exit 1 without writing recovery state.

#### Scenario: Run-start preflight blocks on failure

- **WHEN** `doctor.runOnStart: true` is configured or `--doctor` is passed
- **AND** at least one preflight check fails
- **THEN** the pipeline SHALL print the failing check(s) with remediation text
- **AND** SHALL exit before the planning stage
- **AND** SHALL NOT consume any planning or implementation tokens
- **AND** SHALL report a typed observation or Capability Request
- **AND** RecoverySupervisor SHALL retain ownership of the drive

#### Scenario: Run-start preflight passes — run proceeds normally

- **WHEN** `doctor.runOnStart: true` is configured or `--doctor` is passed
- **AND** all preflight checks pass
- **THEN** the pipeline SHALL proceed to the planning stage as normal

#### Scenario: Existing runs unaffected when preflight is not enabled

- **WHEN** `doctor.runOnStart` is false or absent
- **AND** `--doctor` is not passed
- **THEN** the pipeline run SHALL behave identically to a run without the doctor feature present
- **AND** no preflight checks SHALL execute

#### Scenario: Standalone doctor stays read-only

- **WHEN** the operator runs `pipeline doctor` and a check fails
- **THEN** the process MAY exit 1
- **AND** the command SHALL NOT write a recovery episode, claim, Cooling record, or typed request

---

### Requirement: Run-start preflight SHALL block a run on an adapter readiness failure

When run-start preflight is enabled, a failing harness-adapter readiness check SHALL prevent the assigned stage's model invocation. The pipeline SHALL NOT substitute a different harness or adapter for the failing one, because substituting would silently change the harness under evaluation. The failure SHALL be a typed Capability Request or a RecoverySupervisor observation. The Logical Operation SHALL remain owned. The pipeline SHALL NOT treat the failure as ownerless STOP.

#### Scenario: Run-start preflight aborts before the stage runs

- **WHEN** run-start preflight is enabled and an assigned adapter's readiness check fails
- **THEN** the run SHALL not invoke a model on the assigned stage
- **AND** the stage SHALL NOT be executed on a substitute harness
- **AND** the failure SHALL be reported as a typed observation or Capability Request
- **AND** RecoverySupervisor SHALL retain ownership

---

### Requirement: Doctor SHALL report assigned adapters’ prompt-delivery byte limits and fail on incoherent declarations

`pipeline doctor` (and run-start preflight when enabled) SHALL, for each local-CLI harness adapter
assigned by the active configuration as implementer or reviewer, report that adapter’s declared
prompt-delivery channel and `maxPromptBytes` capability (finite byte limit, unlimited, or unknown)
in the per-check summary and in machine-readable `--json` output.

Doctor SHALL fail a dedicated check when an assigned adapter:

- omits `maxPromptBytes`,
- declares `unknown` while assigned to a production role,
- or declares an incoherent channel and limit pair (for example argv/positional delivery with
  unlimited, or a declaration size/limit policy that disagrees with `maxPromptBytes`).

On failure the check SHALL print remediation that names the adapter and instructs the operator how
to fix the declaration or reassign to a stdin- or file-capable adapter. A failing check SHALL cause
`pipeline doctor` to exit non-zero in accordance with the existing doctor pass/fail contract.

When an assigned adapter declares a finite argv-bound limit, doctor SHALL include remediation text
that production review and fix prompts commonly exceed the OS per-argument ceiling (~128 KiB), so
operators learn the hard ceiling before the first large-context stage failure. Doctor SHALL NOT
require materializing a full stage prompt to satisfy this requirement.

Unassigned adapters MAY be skipped for deep readiness checks under existing unassigned-adapter
rules; skipping an unassigned adapter solely because it is unassigned SHALL NOT by itself fail
doctor.

When the same incoherent-declaration failure occurs during run-start preflight, the drive SHALL NOT
enter planning or invoke a model, and SHALL NOT run the stage on a substitute harness. That failure
SHALL be a typed observation or Capability Request and SHALL leave the Logical Operation owned.

#### Scenario: Doctor reports delivery channel and maxPromptBytes for assigned adapters

- **WHEN** configuration assigns adapters as implementer and/or reviewer
- **AND** `pipeline doctor` runs
- **THEN** the summary SHALL include each assigned adapter’s prompt-delivery channel and
  `maxPromptBytes` value
- **AND** `pipeline doctor --json` SHALL expose the same data on the corresponding check records

#### Scenario: Missing or unknown maxPromptBytes on an assigned adapter fails doctor

- **WHEN** an assigned adapter omits `maxPromptBytes` or declares unknown
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the adapter
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Incoherent argv and unlimited pair fails doctor

- **WHEN** an assigned adapter declares positional/`argv` prompt delivery together with unlimited
  `maxPromptBytes` (or an equivalent incoherent declaration size/limit policy)
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the incoherence

#### Scenario: Argv finite limit above spawnable ceiling fails doctor

- **WHEN** an assigned adapter declares positional/`argv` prompt delivery together with a finite
  `maxPromptBytes` greater than the harness spawnable argv ceiling
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the adapter and the unspawnable limit

#### Scenario: Finite argv-bound assignment includes large-prompt remediation

- **WHEN** an assigned adapter declares finite argv-bound `maxPromptBytes`
- **AND** `pipeline doctor` runs
- **THEN** doctor output for that adapter SHALL include remediation noting that production
  review/fix prompts commonly exceed the ~128 KiB per-argument ceiling

#### Scenario: Run-start preflight blocks on prompt-limit coherence failure

- **WHEN** run-start preflight is enabled
- **AND** an assigned adapter fails the prompt-limit coherence check
- **THEN** the run SHALL not invoke a model on the assigned stage
- **AND** the stage SHALL NOT be executed on a substitute harness
- **AND** the failure SHALL be reported as a typed observation or Capability Request
- **AND** RecoverySupervisor SHALL retain ownership
