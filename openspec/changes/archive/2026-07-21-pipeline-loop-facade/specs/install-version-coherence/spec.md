## ADDED Requirements

### Requirement: `pipeline doctor` SHALL include a `loop:contract-coherence` check

The `pipeline doctor` command SHALL include a `loop:contract-coherence` preflight
check. The check SHALL discover the installed goal-loop skill, read its ownership
manifest (`.goal-loop-manifest.json`, which carries `package` and `version`) and the
contract/ledger schema ids it implements, and compare those schema ids against
Pipeline's supported-set constant. The check SHALL pass when a goal-loop install is
discovered whose schema ids are all in the supported set. It SHALL fail when no
goal-loop install is discovered, when the manifest cannot be read or parsed, or when
any discovered schema id is outside the supported set — including a schema id that is
*newer* than the supported set. A failure detail SHALL name both the discovered
version/schema ids and Pipeline's supported ids, and SHALL carry actionable
remediation.

#### Scenario: Supported goal-loop install — check passes

- **WHEN** `pipeline doctor` runs and the discovered goal-loop install reports a
  manifest version and contract/ledger schema ids that are all within Pipeline's
  supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the goal-loop version and the discovered
  contract schema id

#### Scenario: Unsupported contract schema — check fails naming both sides

- **WHEN** `pipeline doctor` runs and the discovered goal-loop implements a contract
  schema id outside Pipeline's supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the discovered schema id and the supported
  schema id(s)
- **AND** the remediation SHALL instruct the user to align the goal-loop and Pipeline
  versions

#### Scenario: A newer-than-supported contract also fails

- **WHEN** the discovered goal-loop contract schema id is newer than any id in
  Pipeline's supported set
- **THEN** the check SHALL have status `"fail"` rather than passing optimistically

#### Scenario: goal-loop not installed — check fails with an install remediation

- **WHEN** `pipeline doctor` runs and no installed goal-loop skill or manifest can be
  discovered
- **THEN** the `loop:contract-coherence` check SHALL have status `"fail"`
- **AND** the remediation SHALL instruct the user to install goal-loop

---

### Requirement: The installer SHALL verify loop contract compatibility before external mutation

The installer SHALL run the same `loop:contract-coherence` check and SHALL report an
incompatible Pipeline/loop pairing. The verification SHALL run before the installer
performs any external mutation, and an incompatible pairing SHALL be surfaced as a
failure with remediation naming both versions rather than silently completing. The
installer SHALL NOT modify, overwrite, or migrate the goal-loop install or its runs.

#### Scenario: Incompatible pairing is reported at install time

- **WHEN** the installer runs against an environment whose installed goal-loop contract
  schema id is outside Pipeline's supported set
- **THEN** it SHALL surface the `loop:contract-coherence` failure naming both the
  Pipeline and goal-loop versions/schema ids
- **AND** it SHALL NOT report the install as coherent

#### Scenario: Verification precedes external mutation

- **WHEN** the installer detects an incompatible Pipeline/loop pairing
- **THEN** the incompatibility SHALL be detected before any external mutation is
  performed
- **AND** the goal-loop install and its existing runs SHALL be left untouched

---

### Requirement: The `loop:contract-coherence` check SHALL be unit-testable via injectable deps

The check implementation SHALL take the goal-loop discovery root and the file-reading
primitive as injected dependencies rather than resolving them from module-level
filesystem state, so unit tests can supply a fake install root, fake manifest contents,
and fake schema ids with no real filesystem, network, or subprocess access. The same
check function SHALL be used by `pipeline doctor`, by the installer, and by the
`pipeline:loop` run-start preflight, so the three surfaces cannot diverge.

#### Scenario: Fake manifest yields a deterministic outcome

- **WHEN** a unit test invokes the check with an injected discovery root and a reader
  returning controlled manifest and schema content
- **THEN** the result SHALL be determined solely by the injected inputs
- **AND** no real filesystem, network, or subprocess access SHALL occur

#### Scenario: One implementation backs all three surfaces

- **WHEN** the `loop:contract-coherence` outcome is computed for `pipeline doctor`, for
  the installer, and for the `pipeline:loop` run-start preflight with identical inputs
- **THEN** all three SHALL produce the same status and the same remediation text
