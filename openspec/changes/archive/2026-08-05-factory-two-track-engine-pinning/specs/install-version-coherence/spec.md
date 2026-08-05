## ADDED Requirements

### Requirement: pipeline doctor SHALL surface engine track and production-pin coherence

The `pipeline doctor` command SHALL include a preflight check (named `install:engine-track` or
an equivalent stable id) that reports the **production pin** target version (when the pin
artifact is readable), the installed/running engine version, and the classified engine track
(`pinned` or `candidate`) or an explicit pin-match status. When production pinned-track intent
applies and the installed/running version does not match the production pin version (after
normalizing an optional leading `v`), the check SHALL fail with remediation that names both
versions and instructs the operator to reinstall from the pin tag (or to declare a candidate
soak path intentionally). When the pin artifact is missing or unreadable, the check SHALL fail
or warn with remediation to restore the pin artifact rather than silently omitting track
disclosure. When the install matches the pin under pinned intent, the check SHALL pass and the
detail string SHALL include the pin version and track.

This check is additive to `install:version-coherence` (loaded VERSION vs on-disk package) and
`install:version-freshness` (installed vs latest published release tag); it does not replace them.

#### Scenario: Install matches pin — track check passes

- **WHEN** `pipeline doctor` runs and the production pin version equals the installed/running
  version under pinned-track intent
- **THEN** the engine-track check SHALL have status `"pass"`
- **AND** the detail string SHALL include the pin version and indicate track `pinned` (or
  equivalent pin-match language)

#### Scenario: Install differs from pin under production intent — check fails

- **WHEN** `pipeline doctor` runs with production pinned-track intent
- **AND** the production pin version is `1.29.1` but the installed/running version is `1.30.0`
- **THEN** the engine-track check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the pin version and the installed version
- **AND** the remediation SHALL instruct reinstall from the pin tag or intentional candidate use

#### Scenario: Missing pin artifact is not silent

- **WHEN** `pipeline doctor` runs and the production pin artifact cannot be read
- **THEN** the engine-track check SHALL have status `"fail"` or `"warn"`
- **AND** the remediation SHALL instruct restoring or initializing the production pin artifact
- **AND** the check SHALL NOT omit all track disclosure without status

#### Scenario: Candidate soak intent does not require pin match

- **WHEN** `pipeline doctor` or an equivalent preflight runs in an explicit candidate soak context
  (FRG Layer B / factory-gate / documented eval)
- **AND** the installed/running version differs from the production pin
- **THEN** the check SHALL NOT fail solely for pin mismatch
- **AND** SHALL still report the pin target and that the active track is `candidate`

#### Scenario: Non-factory doctor does not fail closed on missing pin

- **WHEN** `pipeline doctor` runs on a non-factory product repository host
- **AND** no explicit `--engine-track` / `engine_track` pinned intent is set
- **AND** the production pin artifact is missing
- **THEN** the engine-track check SHALL NOT fail solely for the missing pin
- **AND** MAY pass or skip with detail that two-track factory policy is inactive

---

### Requirement: The engine-track doctor check SHALL be unit-testable via injectable deps

The engine-track / production-pin coherence check SHALL obtain the pin artifact contents and
the running version through injected parameters or `DoctorDeps` file-read primitives (not
hard-coded module-level filesystem access inside the check body), so unit tests can supply a
fake pin JSON, fake running version, and fake intent without real filesystem, network, or
subprocess calls. Unit tests SHALL cover at least: pin match → pass; pin mismatch under
production intent → fail; missing pin → fail or warn; candidate intent with mismatch → non-fail
for mismatch alone.

#### Scenario: Fake pin and version yield deterministic pass

- **WHEN** a unit test injects pin version `1.29.1`, running version `1.29.1`, and pinned intent
- **THEN** the engine-track check SHALL produce status `"pass"` with no real I/O

#### Scenario: Fake pin mismatch yields deterministic fail

- **WHEN** a unit test injects pin version `1.29.1`, running version `1.30.0`, and production
  pinned intent
- **THEN** the engine-track check SHALL produce status `"fail"` with no real I/O
