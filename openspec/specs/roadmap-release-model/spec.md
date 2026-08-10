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

The engine SHALL perform **full SemVer milestone reconciliation** when
`pipeline roadmap --apply` runs under `release_model: semver` (or when
`release_model` is absent), against one reviewed reconciliation manifest derived
from the plan (see the full-reconciliation requirements in this capability). The
default dry-run run (no `--apply`) SHALL NOT create any milestone, rename or
reopen any milestone, update any milestone description, assign any issue, or
clear any milestone assignment. Under SemVer, milestone write-back SHALL be
idempotent with respect to the reviewed target state: an existing reusable
milestone with the approved identity SHALL be reused rather than duplicated, and
a second apply against already-converged state SHALL perform no further
mutations.

When `release_model` is `continuous`, the engine SHALL create one GitHub
milestone per entry in `plan.json.milestones[]` and assign each listed issue to
that milestone. Continuous dry-run SHALL NOT mutate GitHub. Continuous milestone
creation SHALL remain title-idempotent (reuse existing same title rather than
duplicate). Continuous mode is not required to implement SemVer full
reconciliation (fingerprint gate, stale clear, reopen/rename, or full open-issue
coverage) in this requirement.

#### Scenario: `--apply` creates milestones and assigns issues

- **WHEN** `pipeline roadmap --apply` runs and `plan.json.milestones[]` has two
  entries
- **THEN** under `release_model: continuous`, two GitHub milestones SHALL be
  created (or reused if they already exist with the same title) and each issue
  in each entry's `issue_numbers[]` SHALL be assigned to its corresponding
  milestone
- **AND** under `release_model: semver` (or absent), the engine SHALL execute
  the reviewed reconciliation manifest’s planned create/reuse/reopen/rename/
  description-update/assign/clear-stale actions so live state matches the
  manifest (including those two milestone targets when present)

#### Scenario: SemVer `--apply` converges to the reviewed manifest

- **WHEN** `pipeline roadmap --apply` runs under `release_model: semver` (or
  absent) with a valid reviewed reconciliation manifest and matching live-state
  fingerprint
- **THEN** the engine SHALL execute the manifest’s planned create, reuse,
  reopen, rename, description-update, assign, and clear-stale actions as needed
- **AND** every open issue named in the manifest SHALL have exactly one full
  SemVer milestone matching the manifest after successful apply

#### Scenario: Continuous `--apply` creates milestones and assigns issues

- **WHEN** `pipeline roadmap --apply` runs and `release_model` is `continuous`
  and `plan.json.milestones[]` has two entries
- **THEN** two GitHub milestones SHALL be created (or reused if they already
  exist with the same title)
- **AND** each issue in each entry's `issue_numbers[]` SHALL be assigned to its
  corresponding milestone

#### Scenario: Dry-run does not create milestones or assign issues

- **WHEN** `pipeline roadmap` runs without `--apply`
- **THEN** no GitHub milestone SHALL be created, reopened, renamed, or have its
  description updated
- **AND** no issue SHALL be assigned to any milestone
- **AND** no issue SHALL have a milestone assignment cleared

#### Scenario: SemVer second apply is a no-op on converged state

- **WHEN** `pipeline roadmap --apply` has already converged live state to the
  reviewed SemVer manifest
- **AND** a second `--apply` runs against the same manifest with unchanged live
  state
- **THEN** the engine SHALL report that no mutations are required
- **AND** SHALL NOT create duplicate milestones or re-assign issues already at
  their target milestone

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

### Requirement: Full SemVer reconciliation SHALL cover every open issue with exactly one release milestone

Full SemVer reconciliation apply SHALL leave every open issue in the repository
scope with exactly one full SemVer milestone whose title matches
`v<MAJOR>.<MINOR>.<PATCH>` under `release_model: semver` (or when
`release_model` is absent). The reviewed reconciliation manifest SHALL name that
assignment for each open issue. No open issue SHALL remain unmilestoned after
successful apply. An open issue SHALL NOT be assigned to two milestones. Theme
labels, epic labels, and other non-milestone metadata SHALL NOT count as
satisfying this invariant.

#### Scenario: Successful apply leaves no open issue unmilestoned

- **WHEN** full SemVer reconciliation apply completes successfully
- **THEN** every open issue in scope SHALL have exactly one milestone
- **AND** that milestone's title SHALL match `v<MAJOR>.<MINOR>.<PATCH>`

#### Scenario: Theme label alone does not satisfy the invariant

- **WHEN** an open issue carries a `theme:*` or `epic:*` label but has no SemVer
  milestone assignment in the reviewed manifest
- **THEN** the release-milestone invariant SHALL be unsatisfied for that issue
- **AND** apply SHALL refuse until the manifest assigns a full SemVer milestone

#### Scenario: Manifest forbids dual milestone membership

- **WHEN** the reviewed manifest is validated before apply
- **THEN** no open issue number SHALL appear in more than one target SemVer
  milestone's issue set

### Requirement: SemVer reconciliation version selection SHALL use only #909 applied classification

The engine SHALL select each issue’s target milestone version using only the
resolved applied compatibility impact owned by the exclusive `semver:major` /
`semver:minor` / `semver:patch` classification rules under full SemVer
reconciliation. Free-form issue title text and body text SHALL NOT set, upgrade,
or downgrade the version used for reconciliation. When an open issue has
unresolved applied impact (missing or conflicting explicit `semver:*` labels),
the engine SHALL record a visible coverage blocker in dry-run output and SHALL
NOT apply full reconciliation until that issue has resolved applied impact and a
valid manifest assignment.

#### Scenario: Explicit label drives recon version, not prose

- **WHEN** an open issue carries only `semver:patch` among the three explicit
  SemVer labels
- **AND** its title or body contains the words `breaking change` or `migration`
- **THEN** reconciliation SHALL place that issue according to applied `patch`
  impact
- **AND** SHALL NOT select a major version solely from the prose

#### Scenario: Unresolved classification blocks apply

- **WHEN** any open issue has unresolved applied impact (missing or conflicting
  `semver:*` labels)
- **THEN** dry-run SHALL list that issue as a coverage blocker
- **AND** `--apply` SHALL refuse full SemVer reconciliation without mutating
  milestones for that incomplete manifest

### Requirement: Dry-run SHALL list every planned SemVer reconciliation action before mutation

The engine SHALL emit a dry-run preview that lists every planned action in the
reconciliation manifest when `pipeline roadmap` runs without `--apply` under
SemVer full reconciliation. The listed kinds SHALL include, when applicable:
milestone create, reuse, reopen, rename, description update, issue assignment,
and stale assignment removal. Each listed action SHALL identify the affected
milestone identity and/or issue number with enough detail for an operator to
review the exact intended mutation. The preview SHALL NOT perform any of those
mutations.

#### Scenario: Dry-run enumerates create, assign, and clear-stale actions

- **WHEN** the reviewed target differs from live state by one missing milestone,
  two issue assignments, and one stale assignment
- **AND** the operator runs dry-run SemVer reconciliation
- **THEN** the output SHALL list the create, both assigns, and the clear-stale
  action
- **AND** GitHub state SHALL remain unchanged

#### Scenario: Dry-run enumerates reopen, rename, and description update

- **WHEN** the manifest reuses a closed empty unshipped planning milestone by
  reopening it, renames a reusable non-shipped milestone, and updates a
  description
- **AND** the operator runs dry-run
- **THEN** the output SHALL list reopen, rename, and description-update actions
- **AND** no mutation SHALL occur

### Requirement: SemVer apply SHALL use the exact reviewed manifest and a fresh live-state fingerprint

Full SemVer reconciliation apply SHALL execute only the exact reviewed
reconciliation manifest (same manifest identity as the reviewed preview). Before
the first mutation, the engine SHALL recompute a live-state fingerprint over the
open-issue milestone assignments and the milestone catalog entries relevant to
reconciliation. When that fresh fingerprint differs from the fingerprint
captured with the reviewed preview, the engine SHALL stop apply without applying
the stale plan (or SHALL require a new preview that regenerates the manifest and
fingerprint). Apply SHALL NOT invent additional assignments beyond the reviewed
manifest.

#### Scenario: Matching fingerprint allows apply

- **WHEN** the operator runs `--apply` with the reviewed manifest
- **AND** the fresh live-state fingerprint matches the preview fingerprint
- **THEN** the engine SHALL proceed to execute the planned actions

#### Scenario: Drift after preview stops apply

- **WHEN** an issue’s milestone assignment or a relevant milestone title/state
  changes after preview and before apply
- **AND** the fresh fingerprint no longer matches the preview fingerprint
- **THEN** apply SHALL refuse to mutate
- **AND** SHALL report that a new preview is required

#### Scenario: Changed manifest identity is not silently accepted

- **WHEN** apply is invoked with a manifest identity that does not match the
  reviewed preview identity for the run
- **THEN** the engine SHALL refuse apply
- **AND** SHALL NOT partially execute a different plan under the old fingerprint

### Requirement: SemVer reconciliation SHALL create, reuse, reopen, rename, describe, assign, and clear stale state

Under SemVer full reconciliation, the engine SHALL support the following
mutations when present in the reviewed action list: create missing milestones;
reuse approved existing milestone identities; reopen a closed empty unshipped
planning milestone only when the reviewed manifest names that identity; rename a
reusable non-shipped milestone to the manifest title when planned; update
milestone descriptions to match the manifest; assign each target open issue to
its manifest milestone; and remove stale milestone assignments from open issues
whose live assignment is not the manifest target. The engine SHALL NOT delete
milestones.

#### Scenario: Create missing milestone and assign issues

- **WHEN** the manifest targets title `v1.8.0` and no reusable milestone with that
  approved identity exists
- **THEN** apply SHALL create the milestone
- **AND** SHALL assign each listed open issue to it

#### Scenario: Stale assignment is cleared

- **WHEN** open issue #42 is assigned to `v1.7.0` live
- **AND** the reviewed manifest places #42 on `v1.8.0`
- **THEN** apply SHALL clear or replace the stale assignment so that #42 ends on
  `v1.8.0` only

#### Scenario: Ambiguous title collision fails visibly

- **WHEN** two distinct reusable milestones share the same title and the manifest
  does not name a unique stable identity
- **THEN** reconciliation SHALL fail visibly without silently picking one
- **AND** SHALL NOT create a third duplicate without operator-visible resolution

### Requirement: Closed shipped milestones SHALL remain unchanged; only named unshipped empties may reopen

Full SemVer reconciliation SHALL NOT rename, reopen, rewrite the description of,
or otherwise mutate a closed **shipped** milestone. A closed, empty, unshipped
planning milestone MAY be reopened and reused only when the reviewed manifest
explicitly names that milestone’s identity. The engine SHALL NOT reuse a closed
shipped milestone identity for a new planning lane.

#### Scenario: Closed shipped milestone is immutable

- **WHEN** a milestone is closed and shipped (for example its title matches a
  shipped release tag observed by the engine)
- **THEN** apply SHALL NOT rename, reopen, or update that milestone’s description
- **AND** SHALL NOT treat it as a reusable planning identity for a different
  target

#### Scenario: Named closed empty unshipped milestone may reopen

- **WHEN** the reviewed manifest names the identity of a closed empty unshipped
  planning milestone as the target for a SemVer lane
- **THEN** apply MAY reopen that milestone and reuse it for the planned
  assignments
- **AND** SHALL NOT create a duplicate title when that reopen satisfies the
  manifest

#### Scenario: Closed unshipped milestone without manifest identity is not reopened

- **WHEN** a closed empty unshipped milestone exists but the reviewed manifest
  does not name its identity
- **THEN** apply SHALL NOT reopen it opportunistically

### Requirement: Partial SemVer apply failure SHALL record progress and resume safely

The engine SHALL record which actions completed and which remain pending when
full SemVer reconciliation apply fails after completing one or more actions,
together with the manifest identity and the fingerprint in force at apply start.
A subsequent resume or retry with the same manifest identity SHALL continue from
the first pending action without creating duplicate milestones for
already-completed creates and without repeating assignments that already match
the target. If live state has drifted such that the pending plan is no longer
valid under the fingerprint rules, the engine SHALL abort resume and require a
new preview.

#### Scenario: Resume skips completed create

- **WHEN** apply creates milestone `v1.9.0` then fails before assigning issues
- **AND** the operator retries with the same manifest identity
- **THEN** the engine SHALL reuse the already-created milestone
- **AND** SHALL NOT create a second `v1.9.0` milestone
- **AND** SHALL continue with pending assignments

#### Scenario: Resume aborts on invalidating drift

- **WHEN** progress is pending for a manifest
- **AND** live state has changed so the apply-start fingerprint rules no longer
  validate the pending plan
- **THEN** resume SHALL abort without further mutations
- **AND** SHALL require a new dry-run preview

### Requirement: Full SemVer reconciliation tests SHALL cover drift, collisions, resume, and no-op convergence

The engine’s unit tests for SemVer full reconciliation SHALL inject GitHub
seams (no real network or git) and SHALL cover at least: title collisions; stale
assignment removal; issue-state drift between preview and apply; changed
manifest identity rejection; closed shipped milestone immutability; reusable
closed empty unshipped milestone reopen when named; partial apply with retry
resume; and exact no-op convergence on a second apply against already-converged
state.

#### Scenario: Injected-seam suite includes the required cases

- **WHEN** the SemVer reconciliation test suite runs
- **THEN** it SHALL include cases for title collisions, stale assignments,
  issue-state drift, changed manifest identity, closed shipped milestones,
  reusable unshipped reopen, partial apply resume, and no-op second apply
- **AND** those cases SHALL use injected GitHub seams rather than live API calls

