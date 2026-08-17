## MODIFIED Requirements

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
