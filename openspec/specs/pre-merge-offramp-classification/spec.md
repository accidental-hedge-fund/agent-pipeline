# pre-merge-offramp-classification Specification

## Purpose
TBD - created by archiving change scoreboard-pre-merge-needs-human-by-class. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL define a closed PreMergeOfframpClass for pre-merge blocked and needs-human off-ramps

The engine SHALL define a closed string enum `PreMergeOfframpClass` covering the
structurally distinct pre-merge off-ramp classes operators use for prioritization,
comprising at least: `ci-failed`, `delta-review`, `merge-conflict`, `openspec-invalid`,
`openspec-stale-delta`, and `other`. Every pre-merge transition that blocks an issue or
routes it to needs-human SHALL resolve to exactly one member of this enum. Values outside
the enum SHALL NOT be written as `offramp_class` on durable events. The residual class
`other` SHALL be used when no finer class applies, and SHALL NOT be used when a finer
class is known.

#### Scenario: CI failure maps to ci-failed

- **WHEN** pre-merge blocks because CI checks failed or the local pre-merge test gate
  failed after applicable recovery
- **THEN** the recorded `offramp_class` SHALL be `ci-failed`

#### Scenario: Unresolved delta-review findings map to delta-review

- **WHEN** pre-merge blocks because the review-SHA / delta recheck left blocking findings
  or hit a delta-review ceiling that parks for human action
- **THEN** the recorded `offramp_class` SHALL be `delta-review`

#### Scenario: Unresolved merge conflict maps to merge-conflict

- **WHEN** pre-merge blocks because mergeability is conflicting and automatic rebase did
  not resolve the conflict
- **THEN** the recorded `offramp_class` SHALL be `merge-conflict`

#### Scenario: OpenSpec structural failure maps to openspec-invalid

- **WHEN** pre-merge blocks because OpenSpec validation failed for the active change
- **THEN** the recorded `offramp_class` SHALL be `openspec-invalid`

#### Scenario: Stale OpenSpec delta maps to openspec-stale-delta

- **WHEN** pre-merge blocks because the OpenSpec stale-delta consistency guard fails
- **THEN** the recorded `offramp_class` SHALL be `openspec-stale-delta`

#### Scenario: Unmapped pre-merge block uses other

- **WHEN** pre-merge blocks for a path that has no finer class (for example missing PR
  for the gate, or an explicit needs-human catch-all without a more specific kind)
- **THEN** the recorded `offramp_class` SHALL be `other`

---

### Requirement: Every pre-merge blocked or needs-human off-ramp is recorded on the durable run event stream with class and stage

The engine SHALL append a durable run event when pre-merge returns a blocked outcome or
parks the issue at needs-human (via the existing `blocker_set` emission path or an
additive equivalent on the same stream) that includes at minimum:

- `type` identifying the blocker/off-ramp event
- `at` as an ISO-8601 UTC timestamp
- `stage` equal to `"pre-merge"`
- `offramp_class` equal to exactly one `PreMergeOfframpClass` member
- `reason` free-text detail (existing field; still redacted like other events)

The emission SHALL also record `blocker_kind` when a `BlockerKind` is known for the
path, as an additive field. The write SHALL use the same `appendEvent` / run-store path
as other run events so injection denylist screening, secret redaction, and any configured
event sink apply on identical terms. Classification SHALL NOT depend on scraping issue
comments or PR discussion bodies.

#### Scenario: Pre-merge CI block writes class and stage

- **WHEN** pre-merge blocks with class `ci-failed` for issue N during run R
- **THEN** `events.jsonl` for run R SHALL contain a blocker/off-ramp event with
  `stage` `"pre-merge"` and `offramp_class` `"ci-failed"`
- **AND** the event SHALL include a non-empty `reason` describing the CI failure

#### Scenario: Pre-merge merge-conflict block writes merge-conflict class

- **WHEN** pre-merge blocks with `BlockerKind` `merge-conflict`
- **THEN** the durable event SHALL carry `offramp_class` `"merge-conflict"`
- **AND** `stage` `"pre-merge"`

#### Scenario: Classification does not scrape issue comments

- **WHEN** a pre-merge off-ramp is recorded
- **THEN** the class SHALL be determined from the stage outcome / `BlockerKind` / path
  tag available in-process
- **AND** the engine SHALL NOT fetch or parse issue comments to assign `offramp_class`

#### Scenario: Event write failure remains non-fatal to stage outcome semantics for optional consumers

- **WHEN** appending the durable off-ramp event fails with an I/O error after the block
  has already been applied on GitHub
- **THEN** the issue SHALL remain blocked as the stage decided
- **AND** the failure SHALL be logged as a non-fatal warning consistent with other
  best-effort event emissions (`human_intervention`, papercut)

---

### Requirement: Pre-merge setBlocked paths SHALL supply an accurate BlockerKind so class mapping is deterministic

Every production `setBlocked` call from the pre-merge stage SHALL pass an explicit
`BlockerKind` (not rely on the default alone for distinct failure modes). CI failures
SHALL NOT be recorded solely as generic `needs-human` when a CI-specific kind or path tag
is available for mapping to `ci-failed`. OpenSpec and merge-conflict paths SHALL continue
to use their existing specific kinds (`openspec-invalid`, `openspec-stale-delta`,
`merge-conflict`) so the pure mapper from kind/path → `PreMergeOfframpClass` is
deterministic and unit-testable without network I/O.

#### Scenario: Mapper is pure and total over known kinds

- **WHEN** the class mapper is invoked with each `BlockerKind` used by pre-merge plus the
  path tags for CI and delta-review
- **THEN** it SHALL return exactly one `PreMergeOfframpClass` for each input
- **AND** it SHALL return `other` only for inputs that are not mapped to a finer class

#### Scenario: Distinct pre-merge failure modes do not collapse to a single class

- **WHEN** one pre-merge run blocks on CI failure and another blocks on merge-conflict
- **THEN** their recorded `offramp_class` values SHALL differ (`ci-failed` vs
  `merge-conflict`)

---

### Requirement: Waiting and successful advance paths do not emit a needs-human offramp class

The engine SHALL NOT append a pre-merge needs-human/blocked off-ramp event with
`offramp_class` when pre-merge returns `waiting` (for example rebased and CI re-running,
or OpenSpec archive triggered a CI re-run) or a successful `advanced: true` transition.
Only blocked or needs-human terminal off-ramps for that stage entry SHALL record a class.

#### Scenario: Rebase waiting does not count as needs-human class

- **WHEN** pre-merge successfully rebases and returns `status: "waiting"` for CI re-run
- **THEN** no `offramp_class` blocked/needs-human event SHALL be appended for that path

#### Scenario: Successful pre-merge advance does not record an off-ramp class

- **WHEN** pre-merge advances the issue to the next stage
- **THEN** no pre-merge `offramp_class` blocked event SHALL be written for that successful
  advance

### Requirement: PreMergeOfframpClass SHALL be a derived projection of the canonical reason vocabulary

The engine SHALL treat `PreMergeOfframpClass` as a pure operator-facing projection derived from
the canonical stage-diagnostic reason code plus closed pre-merge path tags / `BlockerKind`, not
as an independent escalation authority taxonomy. Scoreboard and durable event fields MAY continue
to record `offramp_class`, but human-authority and recovery disposition SHALL continue to come
from the stage-diagnostic projection. Every pre-merge blocked off-ramp SHALL still resolve to
exactly one `PreMergeOfframpClass` member, and that mapping SHALL remain pure and unit-testable
without network I/O.

#### Scenario: Offramp class remains total for pre-merge blocks

- **WHEN** pre-merge blocks with a known blocker kind or path tag
- **THEN** the mapper SHALL return exactly one `PreMergeOfframpClass`
- **AND** recovery/human-authority disposition SHALL still be taken from the stage diagnostic

#### Scenario: Offramp class cannot mint human authority alone

- **WHEN** a pre-merge event records `offramp_class` such as `delta-review` or `other`
- **THEN** the supervisor SHALL NOT create a human hold solely from that offramp class
- **AND** SHALL require the canonical authority predicate for any human hold
)

