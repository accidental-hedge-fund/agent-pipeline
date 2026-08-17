# factory-two-track-engine-pinning Specification

## Purpose
TBD - created by archiving change factory-two-track-engine-pinning. Update Purpose after archive.

## Requirements

### Requirement: The factory SHALL maintain a production pin for the last FRG-passed engine release

The repository SHALL maintain a machine-readable **production pin** artifact that names the
engine version of the last Factory Reliability Gate (FRG) pass that has been promoted into
production dogfood. The pin SHALL include at least: a schema version, the pinned semver
`version`, the release `tag` (e.g. `vX.Y.Z`), a `git_sha` when known, a reference to the
authorizing FRG pass (`frg_run_id` or equivalent evidence ref), and a `promoted_at` timestamp.
The pin SHALL be the authoritative target for factory **pinned-track** production and dogfood
runs. Unit CI green alone SHALL NOT update the production pin.

A **production-quality** pin SHALL carry a real FRG `frg_run_id` (not a `no-frg-*` marker)
and a non-null, non-empty `frg_evidence_path` for that version. A pin whose `frg_run_id`
starts with `no-frg-` or whose `frg_evidence_path` is null or empty SHALL NOT be treated as
the last FRG-passed production pin. That marker is only the explicit skip-escape form.

#### Scenario: Pin names a promoted FRG-passed version

- **WHEN** the production pin is read after a successful promote of version `1.30.0`
- **THEN** the pin SHALL report `version` `1.30.0` (and tag `v1.30.0` or equivalent)
- **AND** SHALL carry a non-empty FRG pass reference for that version
- **AND** SHALL carry a `promoted_at` timestamp

#### Scenario: Successful FRG ship pin is production-quality

- **WHEN** a non-skip promote of version `1.37.0` succeeds from FRG evidence with
  `run_id` `frg-abc` and `pass: true`
- **THEN** the written pin SHALL set `frg_run_id` to `frg-abc`
- **AND** SHALL set `frg_evidence_path` to a non-null path for `1.37.0`
- **AND** SHALL NOT set `frg_run_id` to `no-frg-1.37.0`
- **AND** SHALL NOT set `frg_evidence_path` to null

#### Scenario: no-frg marker is not a production-quality pin

- **WHEN** a readable production pin has `frg_run_id` `no-frg-1.37.0` or
  `frg_evidence_path` null
- **THEN** the pin SHALL NOT be treated as the last FRG-passed production pin
- **AND** SHALL NOT satisfy production-quality pin policy

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
`version` (normalizing an optional leading `v`). Version equality alone SHALL NOT be
sufficient to classify a run as track `pinned`: the system SHALL also require verifiable
tag-install provenance (for example an installer receipt identifying the pin tag). A
same-version working-tree candidate without that provenance SHALL NOT be recorded as
`pinned`. Under default pinned intent (factory control production/dogfood only), a missing
or invalid production pin SHALL refuse the run before stages execute rather than silently
reclassifying to candidate and continuing. Ordinary non-factory advances (product
repositories that consume the installed skill without explicit `--engine-track` /
`engine_track` and that are not the factory control repository) SHALL NOT apply pinned-track
enforcement and SHALL NOT require a production pin. The production pin authority SHALL be
the factory control checkout (or an explicitly configured pin path / factory-control dir),
not every target product `repo_dir` under advance. Under active pinned intent against a
non-factory target, when neither factory-control directory nor an explicit pin path is
configured, the system SHALL refuse rather than loading a product-local pin (or treating
a missing product-local pin as the factory pin). Candidate-track evidence SHALL NOT attach
the production pin's `git_sha` as the executing engine SHA.

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

#### Scenario: Same-version working-tree is not coherent pinned without install provenance

- **WHEN** pinned-track production intent applies
- **AND** the running engine version equals the production pin version
- **AND** tag-install provenance for the pin tag cannot be established (for example no
  matching installer receipt, or the engine is a control-repo working tree)
- **THEN** the system SHALL refuse to classify the run as coherent track `pinned`
- **AND** under default pinned intent SHALL refuse the advance before stages (or doctor
  fail with reinstall remediation)

#### Scenario: Working-tree signal outranks a copied or stale installer receipt

- **WHEN** the executing engine root is identified as a control-repo or managed worktree
- **AND** an installer receipt file is also present and parseable for the pin tag
- **THEN** install provenance SHALL classify as `working_tree` (not `tag_install`)
- **AND** pinned-track intent SHALL NOT treat the run as coherent track `pinned`

#### Scenario: Missing pin under pinned intent refuses the run

- **WHEN** pinned-track production intent applies
- **AND** the production pin artifact is missing or invalid
- **THEN** the advance path SHALL refuse before stages execute
- **AND** SHALL NOT continue while only labeling evidence as track `candidate`

#### Scenario: Ordinary non-factory advance does not require a production pin

- **WHEN** an ordinary advance runs against a non-factory product repository
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** no production pin artifact is present in the target repository
- **THEN** the advance path SHALL NOT refuse for `missing_pin`
- **AND** SHALL proceed to stages without requiring factory pin policy

#### Scenario: Pin authority is factory control not every target repo

- **WHEN** pinned-track production intent applies
- **AND** the production pin is configured via factory control path or pin path override
- **AND** the advance target repository differs from that pin authority
- **THEN** pin resolution SHALL use the factory control / override path
- **AND** SHALL NOT require the pin file to exist under the product target `repo_dir`

#### Scenario: Pinned intent without factory pin authority refuses

- **WHEN** pinned-track production intent applies
- **AND** the target repository is not the factory control repository
- **AND** neither factory-control directory (`AGENT_PIPELINE_FACTORY_CONTROL` or equivalent)
  nor an explicit pin path override is configured
- **THEN** the advance path SHALL refuse before stages execute
- **AND** doctor under the same pinned intent SHALL fail
- **AND** remediation SHALL require configuring factory-control directory or pin path
- **AND** SHALL NOT load a product-local pin file as production pin authority

#### Scenario: factory-pin refuses product repository as pin authority

- **WHEN** an operator runs `pipeline factory-pin` (show, init, promote, or rollback)
- **AND** the invocation directory is not the factory control checkout
- **AND** neither factory-control directory (`AGENT_PIPELINE_FACTORY_CONTROL` or equivalent)
  nor an explicit pin path override is configured
- **THEN** the command SHALL refuse before reading or writing a production pin
- **AND** SHALL NOT create or update `.agent-pipeline/production-engine-pin.json` under the
  product repository as if it were factory pin authority

#### Scenario: Candidate evidence does not inherit the production pin SHA

- **WHEN** a run is classified as track `candidate`
- **AND** a production pin with a non-empty `git_sha` is readable
- **THEN** run evidence SHALL NOT set `engine.git_sha` to that pin SHA solely because
  the pin is readable
- **AND** MAY omit `git_sha` when the candidate checkout SHA is not resolved

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

The system SHALL promote a **production-quality** pin to version `X.Y.Z` only when a
conforming FRG evidence artifact for `X.Y.Z` exists with `pass: true`, a non-empty
`run_id` that does **not** start with `no-frg-`, and a usable evidence path for that
version. Default `pipeline factory-pin promote` and non-skip `pipeline engine-promote`
SHALL refuse `no-frg-*` and null evidence. Promotion SHALL update the pin artifact
fields (version, tag, git_sha when known, FRG reference, evidence path, promoted_at)
and SHOULD retain prior pin values for rollback reference. Promotion SHALL NOT merge
pull requests, create git tags, enable auto-merge, or otherwise change release merge
authority. Missing FRG evidence, unparsable evidence, `pass: false`, a `no-frg-*`
`run_id`, or a null/empty evidence path SHALL refuse a production-quality promote.

The explicit `--skip-frg` escape (or the shared resolved skip that already authorizes
FRG skip on engine-promote) MAY write a pin that is clearly marked
non-production-quality: `frg_run_id` SHALL be `no-frg-<X.Y.Z>` and
`frg_evidence_path` SHALL be null. Default promote SHALL NOT take that path.
`pipeline factory-pin promote` SHALL remain FRG-gated and SHALL NOT write the
`no-frg-*` marker.

#### Scenario: FRG pass enables promote

- **WHEN** FRG evidence for version `1.30.0` exists with `pass: true` and a non-empty
  `run_id` that does not start with `no-frg-`
- **AND** an operator or promote helper runs the documented non-skip promote path for `1.30.0`
- **THEN** the production pin SHALL be updated to version `1.30.0`
- **AND** the pin SHALL reference that FRG pass
- **AND** the pin SHALL carry a non-null `frg_evidence_path`

#### Scenario: Missing or failed FRG refuses promote

- **WHEN** no FRG evidence with `pass: true` exists for version `1.30.0`
- **AND** a non-skip promote is attempted for `1.30.0`
- **THEN** the promote path SHALL refuse to update the production pin
- **AND** SHALL surface that FRG pass evidence is required

#### Scenario: no-frg run_id or null evidence refuses default promote

- **WHEN** a non-skip promote is attempted for version `1.37.0`
- **AND** FRG lookup is missing, or the evidence `run_id` starts with `no-frg-`, or
  the promote would write `frg_evidence_path` null
- **THEN** the promote path SHALL refuse
- **AND** SHALL NOT write `frg_run_id` `no-frg-1.37.0` as a production-quality pin
- **AND** the existing pin file SHALL remain unchanged

#### Scenario: Explicit skip writes a marked non-production-quality pin

- **WHEN** `pipeline engine-promote --for 1.37.0 --skip-frg` runs (or the shared
  resolved skip is active)
- **THEN** the promote path MAY write a pin for `1.37.0`
- **AND** that pin SHALL set `frg_run_id` to `no-frg-1.37.0`
- **AND** SHALL set `frg_evidence_path` to null
- **AND** default promote without that skip SHALL NOT write that marker

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
pass, refusal of `no-frg-*` / null evidence on the default promote path, skip-escape marker
writes, and doctor track disclosure helpers SHALL take file read/write, FRG evidence lookup, and
version strings as injected seams. The suite SHALL include tests that fail when pin match,
promote refusal, `no-frg-*` acceptance on the default path, or track labeling regressions are
reintroduced.

#### Scenario: Promote refusal is hermetic

- **WHEN** a unit test invokes promote with injected FRG lookup returning no pass for the version
- **THEN** the pin SHALL remain unchanged
- **AND** no real network, git, or subprocess call SHALL occur

#### Scenario: Default promote refuses no-frg hermetically

- **WHEN** a unit test invokes non-skip promote with injected FRG lookup returning
  `run_id` `no-frg-1.37.0` or missing evidence
- **THEN** the pin SHALL remain unchanged
- **AND** the result SHALL be a refusal
- **AND** no real network, git, or subprocess call SHALL occur

#### Scenario: Track classification is hermetic

- **WHEN** a unit test supplies pin version `1.29.1` and running version `1.29.1` with pinned intent
- **THEN** classification SHALL yield track `pinned` from injected inputs alone
