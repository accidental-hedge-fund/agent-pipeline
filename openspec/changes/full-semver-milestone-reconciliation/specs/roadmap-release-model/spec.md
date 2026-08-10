## MODIFIED Requirements

### Requirement: `pipeline roadmap --apply` SHALL create GitHub milestones from `milestones[]` and assign issues

When `pipeline roadmap --apply` is run under `release_model: semver` (or when
`release_model` is absent), the engine SHALL perform **full SemVer milestone
reconciliation** against one reviewed reconciliation manifest derived from the
plan (see the full-reconciliation requirements in this capability). The default
dry-run run (no `--apply`) SHALL NOT create any milestone, rename or reopen any
milestone, update any milestone description, assign any issue, or clear any
milestone assignment. Under SemVer, milestone write-back SHALL be idempotent
with respect to the reviewed target state: an existing reusable milestone with
the approved identity SHALL be reused rather than duplicated, and a second apply
against already-converged state SHALL perform no further mutations.

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

## ADDED Requirements

### Requirement: Full SemVer reconciliation SHALL cover every open issue with exactly one release milestone

Under `release_model: semver` (or when `release_model` is absent), a successful
full-reconciliation apply SHALL leave every open issue in the repository scope
with exactly one full SemVer milestone whose title matches
`v<MAJOR>.<MINOR>.<PATCH>`. The reviewed reconciliation manifest SHALL name that
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

Under full SemVer reconciliation, the engine SHALL select each issue’s target
milestone version using only the resolved applied compatibility impact owned by
the exclusive `semver:major` / `semver:minor` / `semver:patch` classification
rules. Free-form issue title text and body text SHALL NOT set, upgrade, or
downgrade the version used for reconciliation. When an open issue has unresolved
applied impact (missing or conflicting explicit `semver:*` labels), the engine
SHALL record a visible coverage blocker in dry-run output and SHALL NOT apply
full reconciliation until that issue has resolved applied impact and a valid
manifest assignment.

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

When `pipeline roadmap` runs without `--apply` under SemVer full reconciliation,
the engine SHALL emit a preview that lists every planned action in the
reconciliation manifest. The listed kinds SHALL include, when applicable:
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

When full SemVer reconciliation apply fails after completing one or more
actions, the engine SHALL record which actions completed and which remain
pending, together with the manifest identity and the fingerprint in force at
apply start. A subsequent resume or retry with the same manifest identity SHALL
continue from the first pending action without creating duplicate milestones for
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
