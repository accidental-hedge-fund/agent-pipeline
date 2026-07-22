# run-engine-snapshot-isolation

## ADDED Requirements

### Requirement: Prompt templates SHALL be pinned at process start and never re-read mid-run

The engine SHALL read every prompt template exactly once per process, into an in-memory snapshot
taken when the prompts module is initialized. Every prompt builder SHALL resolve its template from
that snapshot. No prompt-building code path SHALL read a template file from the filesystem at build
time. Consequently, replacing, deleting, or editing any file under the engine's `prompts/`
directory after the process has started SHALL have no effect on any prompt that process
subsequently builds.

#### Scenario: A template swapped mid-run does not reach an already-running builder

- **WHEN** the prompts module has been initialized, `fix.md` is then rewritten on disk to contain a
  placeholder the running code does not supply, and a fix prompt is built afterwards
- **THEN** the built prompt SHALL be identical to one built from the pre-swap template
- **AND** no `Unfilled prompt placeholder(s)` error SHALL be raised

#### Scenario: Templates are read eagerly, not on first use

- **WHEN** the prompts module is initialized and no prompt has yet been built
- **THEN** the snapshot SHALL already contain every template shipped alongside the module
- **AND** a subsequent first-ever build of any template SHALL perform no filesystem read

#### Scenario: No template read occurs during prompt building

- **WHEN** any `build*Prompt()` function is invoked with the template read seam instrumented
- **THEN** the seam SHALL record zero invocations after module initialization

#### Scenario: Unknown template names still fail loudly

- **WHEN** a template name absent from the snapshot is requested
- **THEN** the request SHALL throw an error naming the missing template
- **AND** SHALL NOT fall back to a filesystem read

#### Scenario: Rendered prompt content is unchanged by pinning

- **WHEN** a prompt is built from an unmodified engine install
- **THEN** its rendered text SHALL be identical to the text the pre-change lazy loader produced for
  the same inputs

### Requirement: The run SHALL record the engine identity it is pinned to

At run-directory creation the orchestrator SHALL capture the identity of the engine the run is
executing: the engine version, the resolved engine root path, and a fingerprint derived from the
pinned template snapshot. The fingerprint SHALL change when any template's content changes, even
when the engine version does not. The identity SHALL be captured once, at run start, from the
already-pinned snapshot.

#### Scenario: Engine identity captured at run start

- **WHEN** a run directory is created
- **THEN** the recorded identity SHALL carry the engine version, the engine root path, and the
  template fingerprint

#### Scenario: Fingerprint is content-sensitive

- **WHEN** two engine trees differ only in the content of one prompt template
- **THEN** their computed fingerprints SHALL differ

#### Scenario: Fingerprint is order-independent and stable

- **WHEN** the fingerprint is computed twice over the same template set
- **THEN** both computations SHALL produce the same value regardless of directory enumeration order

### Requirement: Mid-run engine drift SHALL be detected and disclosed without altering the run

At each stage boundary the orchestrator SHALL re-read the on-disk engine version and template
fingerprint and compare them to the values pinned for the run. When they differ, the orchestrator
SHALL append an `engine_drift` event to `events.jsonl` carrying the pinned identity, the observed
identity, and the stage at which the drift was detected; SHALL emit a visible warning naming both
identities; and SHALL record the drift in the evidence bundle. The run SHALL continue against its
pinned snapshot: drift detection SHALL NOT block, abort, retry, or reload the run, and SHALL NOT
change any stage outcome.

#### Scenario: An update landing mid-run is recorded at the next stage boundary

- **WHEN** the on-disk engine version changes from the pinned version while a run is between stages
- **THEN** an `engine_drift` event SHALL be appended naming both versions and the stage
- **AND** the stage SHALL execute and complete exactly as it would without the drift

#### Scenario: A content-only change with an unchanged version is still detected

- **WHEN** the on-disk engine version equals the pinned version but a prompt template's content
  differs from the pinned fingerprint
- **THEN** an `engine_drift` event SHALL be appended

#### Scenario: One event per transition, not per stage boundary

- **WHEN** the engine changes once and the run then executes three further stage boundaries with no
  additional change
- **THEN** exactly one `engine_drift` event SHALL be present for that transition

#### Scenario: A failed drift probe is silent and harmless

- **WHEN** the drift probe throws because engine files are unreadable or a version cannot be
  resolved
- **THEN** no `engine_drift` event SHALL be appended
- **AND** the stage outcome and the run's exit status SHALL be identical to a run in which no drift
  occurred

#### Scenario: Runs without a pinned identity report no drift

- **WHEN** a run directory created before this change (no recorded engine identity) is re-entered
- **THEN** the drift probe SHALL report nothing rather than reporting spurious drift

#### Scenario: No drift on an untouched install

- **WHEN** the engine is not modified for the duration of a run
- **THEN** no `engine_drift` event SHALL be present in `events.jsonl`

### Requirement: Snapshot and drift logic SHALL be injectable and covered by biting regression tests

Template snapshotting, fingerprinting, and drift detection SHALL be exercised through dependency
seams so unit tests perform no real network, git, or subprocess calls, and the suite SHALL include
tests that fail when the behavior is reverted.

#### Scenario: Template-swap regression test bites

- **WHEN** template pinning is reverted to a build-time filesystem read
- **THEN** the mid-run template-swap test SHALL fail with an unfilled-placeholder error

#### Scenario: Drift tests use fakes only

- **WHEN** the drift-detection tests run
- **THEN** they SHALL invoke no real subprocess, git command, or network call
