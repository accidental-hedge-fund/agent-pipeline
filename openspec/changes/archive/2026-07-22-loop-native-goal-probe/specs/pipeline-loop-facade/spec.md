## MODIFIED Requirements

### Requirement: `pipeline:loop` SHALL require the host's built-in autonomous `/goal` mode

`pipeline:loop` SHALL require the active engine's built-in autonomous goal mode
(`/goal` on Claude Code, its Codex equivalent) for loop execution. When that mode is
unavailable, the command SHALL refuse to start, exit non-zero with remediation naming
the missing capability and the engine, and SHALL NOT fall back to a non-durable or
manually-supervised loop.

The capability SHALL be determined by a read-only probe whose signals actually carry
slash-command availability. The probe SHALL resolve, in order: (1) an explicit operator
attestation in pipeline configuration, which is authoritative in both directions; (2) a
positive goal-mode marker in the engine CLI's `--help` output, which SHALL be an accepting
signal only; (3) a documented per-engine minimum version floor compared against the engine's
own `--version` output. Absence of a goal-mode string in `--help` SHALL NOT be treated as
evidence that the capability is missing. The probe SHALL NOT start an engine session, and
SHALL NOT read undocumented engine-internal files.

#### Scenario: Capable host whose `--help` omits the slash command passes

- **WHEN** the active engine is `claude`, its `--version` reports a version at or above the
  documented floor, and its `--help` output contains no `goal` marker
- **THEN** the native-goal check SHALL return a passing result
- **AND** `pipeline:loop` SHALL proceed past preflight to contract compilation

#### Scenario: A goal-mode marker in `--help` still passes

- **WHEN** the engine's `--help` output advertises a built-in goal mode
- **THEN** the native-goal check SHALL return a passing result regardless of the version floor

#### Scenario: Engine below the documented floor fails closed

- **WHEN** the engine's `--version` reports a version below the documented per-engine floor
  and no operator attestation is configured
- **THEN** the native-goal check SHALL fail
- **AND** `pipeline:loop` SHALL exit non-zero having performed no lock acquisition, no ledger
  write, and no GitHub mutation

#### Scenario: Engine with no known native goal mode fails closed

- **WHEN** the active engine has no documented version floor because no native goal mode is
  known for it, and no operator attestation is configured
- **THEN** the native-goal check SHALL fail rather than pass by default

#### Scenario: Unreadable or unparseable version fails closed

- **WHEN** the engine's `--version` invocation fails, returns empty output, or returns a
  string from which no `major.minor.patch` version can be extracted, and no operator
  attestation is configured
- **THEN** the native-goal check SHALL fail rather than assume the capability is present

#### Scenario: No degraded fallback loop

- **WHEN** the native goal mode is unavailable
- **THEN** the command SHALL NOT start any substitute loop, single-shot execution, or
  partial run

---

## ADDED Requirements

### Requirement: The native-goal probe SHALL honor an explicit operator attestation

Pipeline configuration SHALL provide an optional operator attestation key for the engine's
native goal-mode capability, with an automatic-detection default plus explicit
`available` and `unavailable` values. The attestation SHALL take precedence over every
inferred signal in both directions, and SHALL be read from the repository's pipeline
configuration file so the assertion is reviewable and auditable. Omitting the key SHALL leave
behavior unchanged from automatic detection, so existing configurations remain valid.

#### Scenario: Attestation of `available` overrides failed detection

- **WHEN** the attestation key is set to `available` and automatic detection would otherwise
  fail (version unreadable, below floor, or no floor known for the engine)
- **THEN** the native-goal check SHALL pass

#### Scenario: Attestation of `unavailable` overrides successful detection

- **WHEN** the attestation key is set to `unavailable` and the engine's version is at or above
  the documented floor
- **THEN** the native-goal check SHALL fail and `pipeline:loop` SHALL refuse to start

#### Scenario: Absent attestation preserves automatic detection

- **WHEN** the attestation key is absent from `.github/pipeline.yml`
- **THEN** the probe SHALL fall through to the marker and version-floor signals
- **AND** the configuration SHALL remain valid without the key

### Requirement: A native-goal failure SHALL report accurate, actionable remediation

When the native-goal check fails, the remediation text SHALL name the active engine, the
detected engine version string (or state that it could not be read), the required version
floor (or state that no native goal mode is known for that engine), and the operator
attestation key together with its accepted values. The remediation SHALL NOT instruct the
operator to update an engine that already satisfies the documented floor.

#### Scenario: Below-floor failure names version, floor, and attestation key

- **WHEN** the native-goal check fails because the detected version is below the floor
- **THEN** the remediation SHALL include the detected version, the required floor, and the
  attestation key with its accepted values

#### Scenario: Unknown-capability failure does not claim an update will help

- **WHEN** the native-goal check fails for an engine with no documented floor
- **THEN** the remediation SHALL state that no native goal mode is known for that engine and
  point at the attestation key
- **AND** it SHALL NOT assert that updating the engine binary resolves the failure

### Requirement: The per-engine version floor SHALL carry recorded evidence

Each per-engine native-goal version floor SHALL be defined in a single place alongside
recorded evidence: the engine, the version verified, and the date the verification was made.
An engine for which no native goal mode has been verified SHALL be represented explicitly as
having no floor rather than being given a guessed value.

#### Scenario: Floor definition states its evidence

- **WHEN** the version-floor table is inspected
- **THEN** each engine entry SHALL state either a floor with its verifying version and date,
  or an explicit "no known native goal mode" value

#### Scenario: Regression coverage exercises detection through the injected seam

- **WHEN** the native-goal probe's unit tests run
- **THEN** they SHALL drive the probe entirely through the `DoctorDeps` seam with no real
  subprocess, network, or git access
- **AND** they SHALL cover a capable host whose `--help` omits the marker, a below-floor host,
  an engine with no known floor, an unparseable version, and both attestation directions
