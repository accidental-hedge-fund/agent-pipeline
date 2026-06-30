## MODIFIED Requirements

### Requirement: Under `semver`, the engine SHALL bundle ranked issues into version-numbered milestone lanes

When `release_model` is `semver` (or absent), the engine SHALL populate `plan.json.milestones[]`
with version-numbered release milestones whose `title` fields are valid semver version strings
(e.g. `v1.7.0`). The milestones SHALL be non-empty when the backlog has rankable issues. Each
issue number placed into a milestone SHALL appear in exactly one milestone; no issue SHALL be
placed in two milestones. Issues blocked by an unresolved or external decision
(`dependency_graph.blocked_pending_decision`) SHALL NOT be placed in any milestone.

Milestone boundaries SHALL NOT be determined by a fixed issue-count cap. The engine SHALL group
issues by release substance — delivery capacity (effort), compatibility impact, risk, dependency
order, and theme cohesion — as specified by the capacity-aware requirements in this capability.
Consecutive milestone titles SHALL be monotonically increasing valid semver version strings.

#### Scenario: Non-empty milestones when backlog has rankable issues

- **WHEN** `pipeline roadmap` runs with `release_model: semver` and the backlog has at least one rankable issue
- **THEN** `plan.json.milestones[]` SHALL contain at least one entry
- **AND** SHALL NOT equal the empty array `[]`

#### Scenario: Milestone titles are semver version strings

- **WHEN** `plan.json.milestones[]` is inspected after a `semver` run
- **THEN** every entry's `title` field SHALL match the pattern `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.7.0`)
- **AND** the titles in plan order SHALL be monotonically increasing semver versions

#### Scenario: No issue appears in two milestones

- **WHEN** `plan.json.milestones[]` is inspected for any pair of entries
- **THEN** their `issue_numbers[]` arrays SHALL share no element

#### Scenario: Boundaries are not a fixed issue-count cap

- **WHEN** the backlog contains eight `XS`/`S` low-risk issues that fit one release's capacity and no breaking changes
- **THEN** `plan.json.milestones[]` SHALL be allowed to place all eight issues in a single milestone
- **AND** the engine SHALL NOT split them solely because the count exceeds five

#### Scenario: blocked_pending_decision issues are excluded from milestones

- **WHEN** an issue number appears in `dependency_graph.blocked_pending_decision`
- **THEN** that issue SHALL NOT be placed in any entry of `plan.json.milestones[]`
- **AND** all other issues not in `blocked_pending_decision` SHALL still be eligible for placement

#### Scenario: Local in-plan dependencies are not excluded from milestones

- **WHEN** an issue has a local in-plan prerequisite (i.e. it appears in another issue's `must_precede` list) but is NOT in `blocked_pending_decision`
- **THEN** that issue SHALL still be placed in `plan.json.milestones[]`
- **AND** the engine SHALL honor the dependency order rather than exclude the dependent issue

## ADDED Requirements

### Requirement: The engine SHALL allow a single large, risky, or breaking-change issue to occupy its own milestone

The engine SHALL, under the `semver` release model, be able to place a single issue alone in its
own milestone — separate from unrelated issues — when that issue would dominate release capacity:
it is a breaking change (major compatibility impact), or its effort estimate is at least the
configured per-milestone capacity budget (e.g. `L`/`XL`), or it carries high risk. Breaking-change
isolation SHALL be governed by `roadmap.release_capacity.isolate_breaking` (default enabled);
oversized isolation (effort ≥ budget) SHALL hold regardless of that flag because such an issue
cannot share a milestone without exceeding the budget.

#### Scenario: Oversized issue is isolated

- **WHEN** the backlog contains one `XL` issue (effort ≥ the per-milestone capacity budget) and several small unrelated issues
- **THEN** the `XL` issue SHALL appear alone in its own `plan.json.milestones[]` entry
- **AND** the small unrelated issues SHALL NOT share that milestone

#### Scenario: Breaking-change issue is isolated when isolation is enabled

- **WHEN** an issue is classified as a breaking change and `roadmap.release_capacity.isolate_breaking` is enabled (default)
- **THEN** that issue SHALL appear alone in its own `plan.json.milestones[]` entry

#### Scenario: High-risk issue is isolated regardless of effort size

- **WHEN** an issue carries a high-risk signal — specifically a risk entry matching `"Security-sensitive change"` or `"Wide blast radius"` — regardless of its effort size
- **THEN** that issue SHALL appear alone in its own `plan.json.milestones[]` entry
- **AND** other issues SHALL NOT share that milestone even if their combined effort would fit the capacity budget

### Requirement: The engine SHALL group more than five small, low-risk, cohesive issues into one milestone when they fit a release's capacity

Under the `semver` release model, the engine SHALL be able to place more than five small,
low-risk, cohesive issues in a single milestone when their combined delivery capacity fits one
release's capacity budget. The number five SHALL NOT be a grouping boundary.

#### Scenario: More than five small issues form one milestone

- **WHEN** the backlog contains seven `XS` low-risk issues with no breaking changes and no dependency constraints, and their combined effort fits the capacity budget
- **THEN** `plan.json.milestones[]` SHALL be allowed to contain a single entry holding all seven issues
- **AND** no milestone boundary SHALL be introduced solely because the issue count exceeds five

### Requirement: Capacity-aware grouping SHALL preserve dependency order across milestone boundaries

The `semver` milestone grouping SHALL preserve dependency order: for every `must_precede` edge
A→B in `plan.json.dependency_graph.must_precede[]` where both A and B are placed into milestones,
the milestone index of A SHALL be less than or equal to the milestone index of B. The milestone
plan SHALL never require a dependent issue to ship in an earlier milestone than its prerequisite.

#### Scenario: Prerequisite milestone is not after its dependent

- **WHEN** issue B `must_precede`-depends on issue A and both are placed into milestones
- **THEN** A's milestone index SHALL be less than or equal to B's milestone index

#### Scenario: Isolation does not reorder dependencies

- **WHEN** a breaking or oversized issue is isolated into its own milestone and it depends on an earlier-ranked prerequisite
- **THEN** the prerequisite SHALL still appear in an earlier-or-equal milestone than the isolated issue

### Requirement: Semver milestone version increments SHALL reflect compatibility impact

Under the `semver` release model, the version increment from one milestone to the next SHALL
reflect the highest compatibility impact among that milestone's issues, where issue signals are
available. A milestone whose highest-impact issue is a breaking change SHALL bump the **major**
version (`v{M+1}.0.0`); a milestone whose highest impact is a backward-compatible feature SHALL
bump the **minor** version (`v{M}.{N+1}.0`); a maintenance-only milestone SHALL bump the **patch**
version (`v{M}.{N}.{P+1}`). The version walk SHALL start from the latest released tag and SHALL
produce monotonically increasing valid semver titles. Compatibility impact SHALL be inferred from
issue signals already available to the engine (e.g. `breaking-change`/`semver:*` labels, the
`breaking change`/`migration` text heuristic, tier, effort, and risk). The chosen increment SHALL
be recorded on the milestone in a machine-readable field (e.g. `version_impact`).

#### Scenario: Maintenance-only milestone bumps patch

- **WHEN** a milestone contains only maintenance-only issues (e.g. `chore`/`bug`/`refactor` with no feature or breaking signal) and the latest released tag is `v1.6.0`
- **THEN** that milestone's `title` SHALL be `v1.6.1` (a patch bump)
- **AND** its `version_impact` SHALL be `patch`

#### Scenario: Explicit semver:minor label takes precedence over co-present maintenance labels

- **WHEN** an issue carries both a `semver:minor` label and a generic maintenance label (e.g. `bug`)
- **THEN** the engine SHALL classify its compatibility impact as `minor`
- **AND** the co-present maintenance label SHALL NOT downgrade the classification to `patch`

#### Scenario: Feature label outranks co-present maintenance label

- **WHEN** an issue carries both a feature label (e.g. `enhancement`) and a maintenance label (e.g. `chore`)
- **THEN** the engine SHALL classify its compatibility impact as `minor` (feature wins)
- **AND** the maintenance label SHALL NOT downgrade the classification to `patch`

#### Scenario: Backward-compatible feature milestone bumps minor

- **WHEN** a milestone's highest-impact issue is a backward-compatible feature and the prior version is `v1.6.0`
- **THEN** that milestone's `title` SHALL be `v1.7.0` (a minor bump)
- **AND** its `version_impact` SHALL be `minor`

#### Scenario: Breaking milestone bumps major

- **WHEN** a milestone contains an issue classified as a breaking change and the prior version is `v1.6.0`
- **THEN** that milestone's `title` SHALL be `v2.0.0` (a major bump)
- **AND** its `version_impact` SHALL be `major`

### Requirement: Each generated semver milestone SHALL carry a product-term rationale for its release boundary

Under the `semver` release model, every `plan.json.milestones[]` entry SHALL include a non-empty
`rationale` string that explains its release boundary in product terms — naming at least one of:
compatibility impact, theme cohesion, risk/capacity, or dependency ordering. The rationale SHALL
NOT be a bare restatement of ranked positions (e.g. "ranked issues 1–5") without a release-meaning
explanation.

#### Scenario: Rationale names a product-term boundary reason

- **WHEN** any `plan.json.milestones[]` entry is inspected after a `semver` run
- **THEN** its `rationale` SHALL be a non-empty string
- **AND** SHALL reference at least one of: compatibility impact, theme cohesion, risk/capacity, or dependency

### Requirement: Sparse issue metadata SHALL produce a conservative default with recorded uncertainty

The engine SHALL, under the `semver` release model, assign the conservative default compatibility
impact `minor` to any issue whose metadata is too sparse to infer impact confidently (no
impact-bearing label and no impact-bearing text); it SHALL NOT silently treat such an issue as
`patch` or as `major`, and SHALL NOT treat all issues as equal. The engine SHALL record the
uncertainty in `plan.json` — on the affected milestone (e.g. an `uncertainty` note) and/or in
`plan.json.open_questions[]` — so the boundary can be reviewed and promoted by a human.

#### Scenario: Sparse issue defaults to minor and records uncertainty

- **WHEN** an issue has no impact-bearing label and no impact-bearing text (sparse metadata)
- **THEN** the engine SHALL classify its compatibility impact as `minor` (not `patch`, not `major`)
- **AND** the uncertainty SHALL be recorded in `plan.json` on the milestone and/or in `open_questions[]`

#### Scenario: Sparse metadata does not silently equalize issues

- **WHEN** a milestone contains issues with sparse metadata
- **THEN** the engine SHALL NOT omit the uncertainty record
- **AND** the milestone's release boundary SHALL remain auditable from the recorded uncertainty

### Requirement: The `continuous` release model SHALL remain theme/epic-oriented and unaffected by semver capacity rules

When `release_model` is `continuous`, the engine SHALL continue to group issues by theme/epic (as
specified by the existing `continuous` requirements) and SHALL NOT apply the semver capacity
budget, breaking-change isolation, compatibility-impact version selection, or semver titling. No
`continuous` milestone `title` SHALL be a semver version string.

#### Scenario: Continuous model ignores semver capacity rules

- **WHEN** `pipeline roadmap` runs with `release_model: continuous`
- **THEN** the semver capacity budget and breaking-change isolation SHALL NOT be applied
- **AND** no entry in `plan.json.milestones[]` SHALL have a `title` matching the pattern `v<MAJOR>.<MINOR>.<PATCH>`
- **AND** no entry SHALL carry a semver `version_impact`-driven title
