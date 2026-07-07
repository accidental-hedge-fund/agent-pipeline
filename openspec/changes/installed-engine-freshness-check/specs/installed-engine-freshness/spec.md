## ADDED Requirements

### Requirement: pipeline doctor SHALL include an install:version-freshness check

The `pipeline doctor` command SHALL include an `install:version-freshness` preflight
check that compares the installed engine version (the `VERSION` constant loaded at
startup) against the latest published GitHub **release tag** of the engine's own source
repository. The check SHALL query the fixed upstream repository
`accidental-hedge-fund/agent-pipeline` — never `config.repo` (the target repo the
pipeline is operating on). Release lookup SHALL run through the doctor `exec` seam as
`gh release view --repo accidental-hedge-fund/agent-pipeline --json tagName` and read the
`tagName` field. The check SHALL normalize a leading `v` on both the release tag and the
running `VERSION` before comparing dotted numeric version segments. When the installed
version is greater than or equal to the latest release tag the check SHALL report `pass`;
when the installed version is strictly older than the latest release tag the check SHALL
report `warn`.

#### Scenario: Installed version equals the latest release — pass

- **WHEN** `pipeline doctor` runs and the installed `VERSION` (normalized) equals the latest release `tagName` (normalized)
- **THEN** the `install:version-freshness` check SHALL have status `"pass"`
- **AND** the detail string SHALL report the install is up to date

#### Scenario: Installed version is older than the latest release — warn

- **WHEN** `pipeline doctor` runs and the installed `VERSION` is strictly older than the latest release `tagName`
- **THEN** the `install:version-freshness` check SHALL have status `"warn"`
- **AND** the detail string SHALL name both the installed version and the latest release version
- **AND** the remediation text SHALL name the documented update command

#### Scenario: Installed version is newer than the latest release — pass

- **WHEN** `pipeline doctor` runs and the installed `VERSION` is newer than the latest release `tagName` (an unreleased dev build ahead of the tag)
- **THEN** the `install:version-freshness` check SHALL have status `"pass"`
- **AND** the check SHALL NOT report `warn` or `fail`

### Requirement: The version-freshness check SHALL degrade gracefully when the release lookup is unavailable

The `install:version-freshness` check SHALL treat an unavailable release lookup as a
non-signal and report `skip`, never `warn` or `fail`. An unavailable lookup includes: the
`gh release view` invocation exiting non-zero (offline, auth/rate-limit error, network
failure), empty output, output that is not parseable JSON, JSON without a `tagName`
field, or an empty running `VERSION`. A `skip` from this check SHALL NOT set
`PreflightResult.ok` to false and SHALL NOT block a run-start preflight.

#### Scenario: Release lookup fails — check is skipped, not failed

- **WHEN** `pipeline doctor` runs and the `gh release view` lookup exits non-zero or returns unparseable output
- **THEN** the `install:version-freshness` check SHALL have status `"skip"`
- **AND** the detail string SHALL indicate the check was skipped (offline)
- **AND** the check SHALL NOT cause a non-zero exit code

#### Scenario: Running version is empty — check is skipped

- **WHEN** `pipeline doctor` runs and the running `VERSION` is the empty string
- **THEN** the `install:version-freshness` check SHALL have status `"skip"` (there is no installed version to compare)

### Requirement: The version-freshness check SHALL only report and SHALL never auto-update

The `install:version-freshness` check SHALL be report-only. It SHALL NOT modify the
installed skill, run the installer, fetch source, or perform any filesystem or network
mutation of the install. Updating SHALL remain an explicit operator action triggered by
running the documented update command.

#### Scenario: A behind install is reported but not modified

- **WHEN** `pipeline doctor` runs against an install that is older than the latest release
- **THEN** the check SHALL report a `warn`
- **AND** the check SHALL NOT alter the installed files or trigger any update

### Requirement: A documented idempotent update command SHALL refresh the installed skill in place

The project SHALL document a one-step update command that refreshes the installed skill
in place by reusing the existing installer `update` verb
(`npx github:accidental-hedge-fund/agent-pipeline update`, or
`node scripts/install.mjs update` from a clone). Running the command SHALL be idempotent:
a second run on an already-current install SHALL produce a net no-op with no error. The
command SHALL be documented in the README and the host skill docs, and the
`install:version-freshness` check's `warn` remediation SHALL name it.

#### Scenario: Update refreshes the install in place

- **WHEN** the operator runs the documented update command against a stale install
- **THEN** the installed skill SHALL be refreshed in place to the installed source's version

#### Scenario: Running the update command twice is idempotent

- **WHEN** the documented update command is run twice in succession
- **THEN** the second run SHALL be a net no-op and SHALL exit without error

#### Scenario: The warn remediation names the update command

- **WHEN** the `install:version-freshness` check reports `warn`
- **THEN** its remediation text SHALL contain the documented update command

### Requirement: The run-start preflight SHALL surface the version-freshness check without blocking on staleness

When `doctor.runOnStart: true` is configured or `--doctor` is passed, the pipeline SHALL
evaluate the `install:version-freshness` check as part of the run-start preflight. A
`warn` (stale install) or `skip` (offline) from this check SHALL NOT abort the run — the
pipeline SHALL print the warning and proceed to the planning stage.

#### Scenario: Stale install at run start — warning printed, run proceeds

- **WHEN** `doctor.runOnStart: true` or `--doctor` is active and the install is older than the latest release
- **THEN** the pipeline SHALL print the freshness warning with its remediation
- **AND** SHALL proceed to the planning stage (the warn SHALL NOT abort the run)

### Requirement: The version-freshness check SHALL be unit-testable via injectable deps

The `install:version-freshness` check SHALL obtain the release tag through the
`DoctorDeps.exec` seam and SHALL accept the running version as an explicit argument (the
existing `version` parameter to `buildPreflightChecks`), so unit tests can supply a fake
`gh` output and an arbitrary installed version. Unit tests SHALL exercise the pass, warn,
and skip outcomes without performing real subprocess, filesystem, or network calls.

#### Scenario: Fake exec returns a newer tag — deterministic warn

- **WHEN** a unit test calls `buildPreflightChecks` with `version` set to an older value and a `DoctorDeps.exec` fake returning `{"tagName":"v<newer>"}`
- **THEN** the `install:version-freshness` check SHALL produce status `"warn"` with no real network access

#### Scenario: Fake exec fails — deterministic skip

- **WHEN** a unit test supplies a `DoctorDeps.exec` fake whose `gh release view` invocation returns a non-ok result
- **THEN** the `install:version-freshness` check SHALL produce status `"skip"` with no real network access
