## ADDED Requirements

### Requirement: The `roadmap.release_model` config key SHALL govern how the engine groups issues into milestones

`.github/pipeline.yml` `roadmap:` block SHALL accept an optional `release_model` key. Its only valid string values SHALL be `semver` and `continuous`. Setting `release_model` to any other value SHALL cause `resolveConfig()` to throw a validation error naming the key and listing the allowed values; the run SHALL NOT proceed. When `release_model` is absent, the engine SHALL behave identically to `release_model: semver`.

#### Scenario: Valid `semver` value accepted

- **WHEN** `.github/pipeline.yml` sets `roadmap: { release_model: semver }`
- **THEN** `resolveConfig()` SHALL succeed and return `config.roadmap.release_model === 'semver'`

#### Scenario: Valid `continuous` value accepted

- **WHEN** `.github/pipeline.yml` sets `roadmap: { release_model: continuous }`
- **THEN** `resolveConfig()` SHALL succeed and return `config.roadmap.release_model === 'continuous'`

#### Scenario: Invalid value rejected with descriptive error

- **WHEN** `.github/pipeline.yml` sets `roadmap: { release_model: train }`
- **THEN** `resolveConfig()` SHALL throw an error naming `roadmap.release_model` as the offending key and listing `['semver', 'continuous']` as the allowed values

#### Scenario: Absent key defaults to semver behavior

- **WHEN** `.github/pipeline.yml` has a `roadmap:` block with no `release_model` key
- **THEN** the engine SHALL behave as if `release_model: semver` were set
- **AND** `pipeline release` SHALL proceed without refusal

---

### Requirement: Under `semver`, the engine SHALL bundle ranked issues into version-numbered milestone lanes

When `release_model` is `semver` (or absent), the engine SHALL populate `plan.json.milestones[]` with release lanes whose `title` fields are valid semver version strings (e.g. `v1.7.0`). The lanes SHALL be non-empty when the backlog has rankable issues. Each issue number in the backlog SHALL appear in exactly one lane; no issue SHALL be placed in two lanes. Dependency-blocked or externally-awaiting issues SHALL NOT be placed in any lane.

#### Scenario: Non-empty milestones when backlog has rankable issues

- **WHEN** `pipeline roadmap` runs with `release_model: semver` and the backlog has at least one rankable issue
- **THEN** `plan.json.milestones[]` SHALL contain at least one entry
- **AND** SHALL NOT equal the empty array `[]`

#### Scenario: Milestone titles are semver version strings

- **WHEN** `plan.json.milestones[]` is inspected after a `semver` run
- **THEN** every entry's `title` field SHALL match the pattern `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.7.0`)

#### Scenario: No issue appears in two lanes

- **WHEN** `plan.json.milestones[]` is inspected for any pair of entries
- **THEN** their `issue_numbers[]` arrays SHALL share no element

---

### Requirement: Under `continuous`, the engine SHALL group issues by theme/epic and SHALL NOT produce semver version lanes

When `release_model` is `continuous`, the engine SHALL populate `plan.json.milestones[]` with theme/epic groupings. No entry's `title` SHALL be a semver version string. The grouping key SHALL be the `epic:*` or `theme:*` label prefix present on the issues; issues without such a label SHALL be grouped under their roadmap tier name as fallback.

#### Scenario: Milestone titles are not semver strings under continuous

- **WHEN** `pipeline roadmap` runs with `release_model: continuous`
- **THEN** no entry in `plan.json.milestones[]` SHALL have a `title` matching the pattern `v<MAJOR>.<MINOR>.<PATCH>`

#### Scenario: Issues with epic labels are grouped by label

- **WHEN** several issues carry the label `epic:auth` and `release_model` is `continuous`
- **THEN** those issues SHALL appear together in a single `plan.json.milestones[]` entry whose `title` is derived from the `epic:auth` label value

#### Scenario: Issues without epic/theme labels fall back to tier grouping

- **WHEN** an issue carries no `epic:*` or `theme:*` label and `release_model` is `continuous`
- **THEN** that issue SHALL be placed in a milestone entry whose `title` matches its roadmap tier name (e.g. `Tier 3: High-Value / Low-Risk`)

---

### Requirement: Under `continuous`, the engine SHALL record a non-empty per-deploy version marker in `plan.json`

When `release_model` is `continuous`, `plan.json` SHALL contain a non-empty `continuous_version_marker` field using CalVer format `YYYY.0M.MICRO` (where MICRO is a zero-based run index within the calendar month). This field SHALL NOT appear in `plan.json` when `release_model` is `semver` or absent.

#### Scenario: Continuous version marker is present and non-empty

- **WHEN** `pipeline roadmap` runs with `release_model: continuous`
- **THEN** `plan.json.continuous_version_marker` SHALL be a non-empty string matching the pattern `YYYY.0M.N` (e.g. `2026.06.0`)

#### Scenario: Continuous version marker is absent under semver

- **WHEN** `pipeline roadmap` runs with `release_model: semver` or with `release_model` absent
- **THEN** `plan.json` SHALL NOT contain a `continuous_version_marker` field

---

### Requirement: `pipeline roadmap --apply` SHALL create GitHub milestones from `milestones[]` and assign issues

When `pipeline roadmap --apply` is run, the engine SHALL create one GitHub milestone per entry in `plan.json.milestones[]` and assign each listed issue to that milestone. This applies under both `semver` and `continuous` models. The default dry-run run (no `--apply`) SHALL NOT create any milestone or assign any issue. Milestone creation SHALL be idempotent: an existing milestone with the same title SHALL be reused rather than creating a duplicate.

#### Scenario: `--apply` creates milestones and assigns issues

- **WHEN** `pipeline roadmap --apply` runs and `plan.json.milestones[]` has two entries
- **THEN** two GitHub milestones SHALL be created (or reused if they already exist with the same title)
- **AND** each issue in each entry's `issue_numbers[]` SHALL be assigned to its corresponding milestone

#### Scenario: Dry-run does not create milestones or assign issues

- **WHEN** `pipeline roadmap` runs without `--apply`
- **THEN** no GitHub milestone SHALL be created
- **AND** no issue SHALL be assigned to any milestone

---

### Requirement: `pipeline release` SHALL refuse to run when `release_model` is `continuous`

When the active `release_model` is `continuous`, the `pipeline release` sub-command SHALL exit non-zero before creating a release branch, bumping the version, or opening a PR. It SHALL print a message stating that release bundling is unavailable under the `continuous` release model and naming the `roadmap.release_model` config key.

#### Scenario: Continuous model causes immediate refusal

- **WHEN** the user runs `pipeline release minor` and `.github/pipeline.yml` sets `roadmap: { release_model: continuous }`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL print a message naming `roadmap.release_model` and indicating the `continuous` model does not support versioned release bundling
- **AND** no release branch SHALL be created and no version bump SHALL be written

#### Scenario: Semver model (or absent) does not cause refusal

- **WHEN** the user runs `pipeline release minor` and `release_model` is `semver` or absent
- **THEN** the command SHALL proceed with the normal release flow without triggering the refusal gate
