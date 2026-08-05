## ADDED Requirements

### Requirement: The factory SHALL maintain a production pin for the last FRG-passed engine release

The repository SHALL maintain a machine-readable **production pin** artifact that names the
engine version of the last Factory Reliability Gate (FRG) pass that has been promoted into
production dogfood. The pin SHALL include at least: a schema version, the pinned semver
`version`, the release `tag` (e.g. `vX.Y.Z`), a `git_sha` when known, a reference to the
authorizing FRG pass (`frg_run_id` or equivalent evidence ref), and a `promoted_at` timestamp.
The pin SHALL be the authoritative target for factory **pinned-track** production and dogfood
runs. Unit CI green alone SHALL NOT update the production pin.

#### Scenario: Pin names a promoted FRG-passed version

- **WHEN** the production pin is read after a successful promote of version `1.30.0`
- **THEN** the pin SHALL report `version` `1.30.0` (and tag `v1.30.0` or equivalent)
- **AND** SHALL carry a non-empty FRG pass reference for that version
- **AND** SHALL carry a `promoted_at` timestamp

#### Scenario: Green unit CI does not move the pin

- **WHEN** `npm run ci` is green for an unreleased candidate and no FRG promote has run
- **THEN** the production pin version SHALL remain unchanged

---

### Requirement: Pinned-track production and dogfood runs SHALL execute the production pin install

Factory production and dogfood runs that operate on the **pinned** track SHALL execute the
engine install corresponding to the production pin (the existing tag-pinned install path
`npx …#<tag> install` or an equivalent install of that tag), not an unpinned floating
default-branch install and not an ad-hoc unreleased working-tree engine used as if it were
production. The running engine version for a pinned-track run SHALL match the pin's
`version` (normalizing an optional leading `v`).

#### Scenario: Pinned-track run matches the pin version

- **WHEN** a factory production/dogfood run is classified as track `pinned`
- **AND** the production pin version is `1.29.1`
- **THEN** the engine version recorded for that run SHALL equal `1.29.1` (ignoring a leading `v`)
- **AND** the run SHALL NOT silently substitute a different candidate build as the production engine

#### Scenario: Unpinned floating install is not a valid pinned-track production posture

- **WHEN** the installed/running engine does not match the production pin version
- **AND** the operator claims or configures pinned-track production intent
- **THEN** the system SHALL treat the posture as misconfigured (doctor fail or equivalent policy signal)
- **AND** SHALL NOT present the run as a coherent pinned production execution

---

### Requirement: The candidate track SHALL be reserved for FRG Layer B and documented eval soaks

The candidate engine track SHALL be reserved for FRG Layer B soaks and documented eval
campaigns. The candidate track is the working tree, release branch, or other unreleased build
ahead of or distinct from the production pin. Ordinary factory production/dogfood loops SHALL
NOT silently classify or run the candidate as the pinned production engine. Candidate runs
SHALL be labeled track `candidate` in run evidence.

#### Scenario: FRG Layer B run is candidate track

- **WHEN** an FRG Layer B / factory-gate soak executes against a release candidate build
- **THEN** the run evidence SHALL record engine track `candidate`
- **AND** SHALL record the candidate engine version and root identity

#### Scenario: Production dogfood does not silently absorb the candidate

- **WHEN** a factory production/dogfood loop is intended as pinned-track
- **AND** only a candidate build is installed (version ≠ pin)
- **THEN** doctor or run-start policy SHALL surface a pin mismatch rather than silently treating
  the candidate as the production pin

---

### Requirement: Promoting the production pin SHALL require an FRG pass for that version

The system SHALL promote the production pin to version `X.Y.Z` only when a conforming FRG
evidence artifact for `X.Y.Z` exists with `pass: true`. Promotion SHALL update the pin artifact
fields (version, tag, git_sha when known, FRG reference, promoted_at) and SHOULD retain prior
pin values for rollback reference. Promotion SHALL NOT merge pull requests, create git tags,
enable auto-merge, or otherwise change release merge authority. Missing FRG evidence, unparsable
evidence, or `pass: false` SHALL refuse promotion.

#### Scenario: FRG pass enables promote

- **WHEN** FRG evidence for version `1.30.0` exists with `pass: true` and a non-empty `run_id`
- **AND** an operator or promote helper runs the documented promote path for `1.30.0`
- **THEN** the production pin SHALL be updated to version `1.30.0`
- **AND** the pin SHALL reference that FRG pass

#### Scenario: Missing or failed FRG refuses promote

- **WHEN** no FRG evidence with `pass: true` exists for version `1.30.0`
- **AND** a promote is attempted for `1.30.0`
- **THEN** the promote path SHALL refuse to update the production pin
- **AND** SHALL surface that FRG pass evidence is required

#### Scenario: Promote does not merge or tag

- **WHEN** a promote of the production pin succeeds
- **THEN** the promote path SHALL NOT merge any pull request
- **AND** SHALL NOT create or push a git tag
- **AND** SHALL NOT enable auto-merge

---

### Requirement: Rollback SHALL repoint the production pin to a previous FRG-passed release

Rollback of the factory production engine SHALL consist of repointing the production pin to a
previous FRG-passed release version (using retained prior-pin metadata when available) and
reinstalling the skill from that release tag. After rollback, doctor on a correctly reinstalled
host SHALL report track coherence with the restored pin. Rollback SHALL NOT require force-push
of product branches or autonomous merges.

#### Scenario: Rollback restores prior pin target

- **WHEN** the production pin is at `1.30.0` and prior pin metadata names `1.29.1`
- **AND** the operator executes the documented rollback to `1.29.1` and reinstalls from that tag
- **THEN** the production pin SHALL name version `1.29.1`
- **AND** a coherent install SHALL report pinned-track match for `1.29.1`

#### Scenario: Rollback procedure is documented

- **WHEN** an operator reads the two-track / pin docs or FRG runbook cross-links
- **THEN** the rollback steps (repoint pin, reinstall from tag, verify with doctor) SHALL be present

---

### Requirement: Track identity SHALL be disclosed on doctor and in run evidence

Every factory-relevant run SHALL record engine track (`pinned` or `candidate`) together with
engine version and install root (and git SHA when resolvable) in run evidence. `pipeline doctor`
SHALL surface the production pin target, the installed/running version, and the classified track
so operators can attribute defects to the correct build. Track disclosure closes stale-install /
phantom-defect misattribution by making the executing engine identity explicit.

#### Scenario: Run evidence carries track

- **WHEN** a run directory is created for a pipeline or loop item execution
- **THEN** the recorded engine identity SHALL include `track` of `pinned` or `candidate`
- **AND** SHALL include the engine `version` and `root`

#### Scenario: Doctor surfaces pin and track

- **WHEN** `pipeline doctor` runs on a host with a readable production pin and a resolvable install
- **THEN** the doctor output SHALL name the production pin version
- **AND** SHALL name the installed/running version
- **AND** SHALL name the classified track or pin-match status

---

### Requirement: Two-track policy SHALL be documented for operators

Project documentation (README and/or FRG runbook and/or config docs) SHALL describe: the two
tracks (pinned vs candidate), where the production pin lives, how production dogfood installs
from the pin tag, how FRG pass feeds promote, how rollback works, and how doctor/run evidence
disclose track. Documentation SHALL NOT claim that FRG pass auto-merges or auto-tags releases.

#### Scenario: Docs name both tracks and pin install

- **WHEN** an operator follows the documented factory engine install for production dogfood
- **THEN** the docs SHALL instruct installing from the production pin tag
- **AND** SHALL distinguish that path from candidate FRG/eval soaks

#### Scenario: Docs do not grant auto-merge authority to promote

- **WHEN** the promote/rollback documentation is read
- **THEN** it SHALL state that promote updates the pin and reinstall expectation only
- **AND** SHALL NOT state that promote merges PRs or creates release tags

---

### Requirement: Two-track pin logic SHALL be unit-testable without real I/O

Two-track pin logic SHALL accept injected dependencies so unit tests perform no real network,
git, or subprocess calls. Pin resolution, track classification, promote refusal without FRG
pass, and doctor track disclosure helpers SHALL take file read/write, FRG evidence lookup, and
version strings as injected seams. The suite SHALL include tests that fail when pin match,
promote refusal, or track labeling regressions are reintroduced.

#### Scenario: Promote refusal is hermetic

- **WHEN** a unit test invokes promote with injected FRG lookup returning no pass for the version
- **THEN** the pin SHALL remain unchanged
- **AND** no real network, git, or subprocess call SHALL occur

#### Scenario: Track classification is hermetic

- **WHEN** a unit test supplies pin version `1.29.1` and running version `1.29.1` with pinned intent
- **THEN** classification SHALL yield track `pinned` from injected inputs alone
