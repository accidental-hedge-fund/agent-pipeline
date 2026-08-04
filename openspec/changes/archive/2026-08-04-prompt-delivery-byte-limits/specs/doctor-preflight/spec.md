## ADDED Requirements

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
- **THEN** the run SHALL abort before the assigned stage invokes a model
- **AND** the stage SHALL NOT be executed on a substitute harness
