## MODIFIED Requirements

### Requirement: `pipeline doctor` SHALL include a `loop:contract-coherence` check

The `pipeline doctor` command SHALL include a `loop:contract-coherence` preflight
check. The check SHALL discover an installed external goal-loop skill (when
present), read its ownership manifest (`.goal-loop-manifest.json`, which carries
`package` and `version`) and the contract/ledger schema ids it implements, and
compare those schema ids against Pipeline's supported-set constant.

The check SHALL **pass** when a goal-loop install is discovered whose schema ids
are all in the supported set. It SHALL **fail** when a goal-loop install is
discovered but the manifest cannot be read or parsed, or when any discovered
schema id is outside the supported set — including a schema id that is *newer*
than the supported set. A failure detail SHALL name both the discovered
version/schema ids and Pipeline's supported ids, and SHALL carry actionable
remediation.

When **no** goal-loop install is discovered, the check SHALL **not** fail. It
SHALL report status **`skip`** (preferred) or **`warn`**, with detail that an
external goal-loop skill is optional/legacy and is **not** required for
`pipeline loop` / the in-repo durable loop. Absence of goal-loop SHALL NOT cause
`pipeline doctor` to exit non-zero solely on this check.

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

#### Scenario: goal-loop not installed — check does not fail

- **WHEN** `pipeline doctor` runs and no installed goal-loop skill or manifest can be
  discovered
- **THEN** the `loop:contract-coherence` check SHALL have status `"skip"` or `"warn"`
- **AND** the check SHALL NOT have status `"fail"`
- **AND** the detail SHALL indicate that external goal-loop is optional/legacy and not
  required for `pipeline loop`
- **AND** doctor overall exit status SHALL NOT be non-zero solely because of this check

### Requirement: The installer SHALL verify loop contract compatibility before external mutation

The installer SHALL run the same external-goal-loop `loop:contract-coherence` check
used by `pipeline doctor` when evaluating a *discovered* goal-loop install. The
verification SHALL run before the installer performs any external mutation. An
**incompatible** discovered pairing (schema ids outside the supported set, or an
unreadable manifest/schema at a discovered install) SHALL be surfaced as a failure
with remediation naming both versions rather than silently completing. The installer
SHALL NOT modify, overwrite, or migrate the goal-loop install or its runs.

When **no** goal-loop install is discovered, the installer SHALL complete
successfully with respect to this check (info-level or silent is allowed). The
installer SHALL NOT claim that `pipeline loop` is unavailable
until goal-loop is installed — durable loop is provided in-repo and does not require
the external skill.

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

#### Scenario: Missing goal-loop does not block install or misstate loop availability

- **WHEN** the installer runs and no goal-loop skill is discoverable
- **THEN** the installer SHALL NOT treat loop contract coherence as a hard failure
- **AND** install output SHALL NOT state that `pipeline loop`
  requires or is unavailable without goal-loop

### Requirement: The `loop:contract-coherence` check SHALL be unit-testable via injectable deps

The external-goal-loop `loop:contract-coherence` implementation SHALL take the
goal-loop discovery root and the file-reading primitive as injected dependencies
rather than resolving them from module-level filesystem state, so unit tests can
supply a fake install root, fake manifest contents, and fake schema ids with no real
filesystem, network, or subprocess access. The same check function SHALL be used by
`pipeline doctor` and by the installer so those two surfaces cannot diverge on
external goal-loop discovery semantics.

`pipeline loop` run-start preflight SHALL NOT require external goal-loop discovery
for success; it SHALL use the in-repo durable loop store schema-compatibility check
(and other in-repo loop preflight checks) instead. Unit tests for
`loop:contract-coherence` SHALL cover at least: supported install → pass; unsupported
schema → fail; absence → skip or warn (not fail).

#### Scenario: Fake manifest yields a deterministic outcome

- **WHEN** a unit test invokes the check with an injected discovery root and a reader
  returning controlled manifest and schema content
- **THEN** the result SHALL be determined solely by the injected inputs
- **AND** no real filesystem, network, or subprocess access SHALL occur

#### Scenario: Doctor and installer share external coherence semantics

- **WHEN** the external `loop:contract-coherence` outcome is computed for
  `pipeline doctor` and for the installer with identical discovery inputs
- **THEN** both SHALL produce the same status class for that input (pass, fail, or
  skip/warn on absence) and compatible remediation text on failure

#### Scenario: Absence is non-failing in unit tests

- **WHEN** a unit test invokes the check with no discoverable goal-loop install
- **THEN** the result status SHALL be `"skip"` or `"warn"`
- **AND** the result status SHALL NOT be `"fail"`
