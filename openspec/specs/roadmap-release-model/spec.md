# roadmap-release-model Specification

## Purpose
TBD - created by archiving change roadmap-release-model-config. Update Purpose after archive.
## Requirements
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

### Requirement: Under `semver`, the engine SHALL bundle ranked issues into version-numbered milestone lanes

When `release_model` is `semver` (or absent), the engine SHALL populate
`plan.json.milestones[]` with release lanes whose `title` fields are valid
semver version strings (e.g. `v1.7.0`). The lanes SHALL be non-empty when the
backlog has at least one rankable issue that has a **resolved** applied
compatibility-impact classification. Each **resolved** issue number that is
eligible for SemVer milestone assignment SHALL appear in exactly one lane; no
issue SHALL be placed in two lanes. The engine SHALL NOT place any of the
following into a SemVer milestone lane:

- dependency-blocked or externally-awaiting issues
- issues whose applied compatibility impact is unresolved (missing explicit
  `semver:*` label, or conflicting explicit `semver:*` labels)

Unresolved issues SHALL remain visible in the plan via the compatibility
classification record (and apply preview / Markdown surfaces) without automatic
milestone assignment.

#### Scenario: Non-empty milestones when backlog has rankable issues

- **WHEN** `pipeline roadmap` runs with `release_model: semver` and the backlog
  has at least one rankable issue with a resolved applied SemVer classification
- **THEN** `plan.json.milestones[]` SHALL contain at least one entry
- **AND** SHALL NOT equal the empty array `[]`

#### Scenario: Milestone titles are semver version strings

- **WHEN** `plan.json.milestones[]` is inspected after a `semver` run
- **THEN** every entry's `title` field SHALL match the pattern
  `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.7.0`)

#### Scenario: No issue appears in two lanes

- **WHEN** `plan.json.milestones[]` is inspected for any pair of entries
- **THEN** their `issue_numbers[]` arrays SHALL share no element

#### Scenario: Unresolved impact issues are omitted from automatic lanes

- **WHEN** a rankable issue has unresolved applied compatibility impact
  (missing or conflicting `semver:*` labels)
- **THEN** that issue's number SHALL NOT appear in any
  `plan.json.milestones[][].issue_numbers[]` entry for that run
- **AND** the issue SHALL still appear in the plan's per-issue compatibility
  classification record as unresolved

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

### Requirement: Under `continuous`, the engine SHALL record a non-empty per-deploy version marker in `plan.json`

When `release_model` is `continuous`, `plan.json` SHALL contain a non-empty `continuous_version_marker` field using CalVer format `YYYY.0M.<short>`, where `<short>` is a short prefix of the backlog SHA the roadmap was generated against. The marker SHALL be **deterministic and lock-free**: it is a pure function of the calendar month and the backlog SHA, with no read-modify-write counter — so concurrent roadmap runs require no serializing lock and never strand one. This field SHALL NOT appear in `plan.json` when `release_model` is `semver` or absent.

#### Scenario: Continuous version marker is present, non-empty, and deterministic

- **WHEN** `pipeline roadmap` runs with `release_model: continuous`
- **THEN** `plan.json.continuous_version_marker` SHALL be a non-empty string matching the pattern `YYYY.0M.<short>` (e.g. `2026.06.a1b2c3d`)
- **AND** two runs in the same calendar month against the same backlog SHA SHALL produce the **same** marker (no counter, no lock)

#### Scenario: Continuous version marker is absent under semver

- **WHEN** `pipeline roadmap` runs with `release_model: semver` or with `release_model` absent
- **THEN** `plan.json` SHALL NOT contain a `continuous_version_marker` field

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

### Requirement: Applied SemVer compatibility impact SHALL come only from exclusive `semver:*` labels

The engine SHALL determine **applied** compatibility impact for each issue under
the `semver` release model (or when `release_model` is absent) solely from the
mutually exclusive labels `semver:major`, `semver:minor`, and `semver:patch`
(label name match SHALL be case-insensitive). Exactly one distinct class among
those three present on the issue SHALL resolve applied impact to `major`,
`minor`, or `patch` respectively. Free-form issue title text and body text SHALL
NOT set, upgrade, or downgrade applied impact. Generic type labels
(`bug`, `enhancement`, and peers) and non-`semver:*` signal labels SHALL NOT set
applied impact.

#### Scenario: Explicit semver:major resolves applied major

- **WHEN** an issue carries `semver:major` and does not carry `semver:minor` or
  `semver:patch`
- **THEN** the engine SHALL set applied impact to `major`
- **AND** SHALL record the source label as `semver:major`

#### Scenario: Explicit semver:patch remains patch despite breaking-language prose

- **WHEN** an issue carries only `semver:patch` among the three explicit SemVer
  labels
- **AND** its title or body contains the words `breaking change` or `migration`
- **THEN** the engine SHALL set applied impact to `patch`
- **AND** SHALL NOT set applied impact to `major`

#### Scenario: Incidental migration prose without SemVer label does not produce major

- **WHEN** an issue carries none of `semver:major`, `semver:minor`, or
  `semver:patch`
- **AND** its title or body contains the word `migration` (or `breaking change`)
- **THEN** the engine SHALL NOT set applied impact to `major`
- **AND** applied classification SHALL remain unresolved (missing explicit
  label)

#### Scenario: Title or body edit alone does not change applied impact

- **WHEN** an issue's explicit SemVer labels are unchanged
- **AND** only the title and/or body text change
- **THEN** the engine SHALL produce the same applied impact (or the same
  unresolved status) as before the text edit

### Requirement: Conflicting explicit SemVer labels SHALL be unresolved and SHALL block automatic milestone assignment

The engine SHALL classify applied impact as unresolved with a conflict status
when an issue carries two or more distinct labels from the set
`{semver:major, semver:minor, semver:patch}`. It SHALL NOT pick a winner, SHALL
NOT assign the issue to any SemVer milestone automatically, and SHALL surface
the conflict in plan artifacts.

#### Scenario: Conflicting semver labels fail visibly without assignment

- **WHEN** an issue carries both `semver:major` and `semver:patch` (or any other
  distinct pair among the three)
- **THEN** the per-issue classification record SHALL mark the issue as
  unresolved conflict
- **AND** SHALL list the conflicting labels
- **AND** the issue number SHALL NOT appear in any automatic
  `milestones[].issue_numbers[]` assignment for that run

### Requirement: Missing explicit SemVer labels SHALL remain visibly uncertain for applied impact

The engine SHALL treat applied impact as unresolved (missing) when an issue
carries none of `semver:major`, `semver:minor`, or `semver:patch`. It SHALL
record uncertainty on the classification. It SHALL NOT silently default applied
impact to `major`, `minor`, or `patch` for the release plan. It MAY emit a
non-binding **recommendation** derived only from generic type labels (and
optional non-authoritative `breaking` / `breaking-change` labels), but that
recommendation SHALL NOT replace explicit impact for applied milestone
versioning or assignment.

#### Scenario: Missing SemVer label is unresolved even with type labels

- **WHEN** an issue carries `bug` or `enhancement` (or both) and none of the
  three explicit `semver:*` impact labels
- **THEN** applied impact SHALL be unresolved (missing)
- **AND** the engine MAY record a recommendation (e.g. patch for `bug`, minor
  for `enhancement`)
- **AND** the issue SHALL NOT receive automatic SemVer milestone assignment on
  the strength of the type label alone

#### Scenario: Recommendation does not set milestone version_impact

- **WHEN** only unresolved-missing issues exist with type-label recommendations
- **THEN** the engine SHALL NOT create SemVer milestone version increments from
  those recommendations alone
- **AND** any emitted recommendation SHALL be marked as non-applied guidance

### Requirement: The classifier SHALL record per-issue impact provenance in plan artifacts

For each classified issue under the `semver` model, the engine SHALL record in
`plan.json` a per-issue compatibility classification that includes at least:

- selected applied impact (`major` | `minor` | `patch`) or an explicit unresolved
  status
- source label when applied impact is resolved from a `semver:*` label
- uncertainty / unresolved reason when applied impact is not resolved
- optional recommendation fields when present

The same provenance (impact, source, uncertainty/status) SHALL appear in the
Markdown roadmap output and in the dry-run / apply preview surfaces so operators
can audit classification without opening only `plan.json`.

#### Scenario: plan.json carries impact, source, and uncertainty

- **WHEN** `pipeline roadmap` completes under `semver` with at least one open
  issue in scope
- **THEN** `plan.json` SHALL include a per-issue classification record for that
  issue containing applied impact or unresolved status, source label when
  resolved, and uncertainty when unresolved

#### Scenario: Markdown and apply preview surface the same classification

- **WHEN** the engine writes Markdown roadmap output or prints the apply /
  dry-run preview for a SemVer plan
- **THEN** each classified issue's displayed line or section SHALL include the
  selected impact (or unresolved status), the source label when resolved, and
  uncertainty when unresolved

### Requirement: Semver milestone version_impact SHALL use only resolved applied classifications

The engine SHALL set each SemVer milestone's machine-readable `version_impact`
and version title walk from the highest **resolved applied** impact among issues
actually placed in that milestone (major / minor / patch bump from the latest
released tag). Unresolved issues and recommendations SHALL NOT contribute to
`version_impact` or to major/minor/patch title selection.

#### Scenario: Explicit major issue drives major bump

- **WHEN** a milestone contains an issue with resolved applied impact `major`
  from `semver:major` and the prior version is `v1.6.0`
- **THEN** that milestone's `title` SHALL be `v2.0.0`
- **AND** its `version_impact` SHALL be `major`

#### Scenario: Unresolved issues do not force a major bump

- **WHEN** the only issues with `migration` or `breaking change` in their bodies
  lack explicit `semver:*` labels
- **THEN** the engine SHALL NOT create a major version lane solely from that
  prose
- **AND** those issues SHALL remain unresolved for applied impact

### Requirement: Continuous release model SHALL remain unaffected by SemVer impact classification rules

When `release_model` is `continuous`, the engine SHALL continue to group issues
by theme/epic (and tier fallback) and SHALL NOT apply SemVer exclusive-label
impact classification, SemVer unresolved exclusion rules, or SemVer title
increments. No continuous milestone `title` SHALL be a semver version string.

#### Scenario: Continuous mode ignores SemVer impact authority path

- **WHEN** `pipeline roadmap` runs with `release_model: continuous`
- **THEN** the exclusive `semver:*` applied-impact path and automatic SemVer
  lane assignment rules SHALL NOT govern continuous grouping
- **AND** no entry in `plan.json.milestones[]` SHALL have a `title` matching
  `v<MAJOR>.<MINOR>.<PATCH>`

