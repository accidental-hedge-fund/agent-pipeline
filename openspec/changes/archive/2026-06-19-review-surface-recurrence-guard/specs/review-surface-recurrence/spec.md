## ADDED Requirements

### Requirement: Blocking findings SHALL be clustered across rounds by `(file + category)` surface

The pipeline SHALL derive a stable **surface key** for each finding from its
normalized file path and structured category: `surfaceKey(f)` SHALL equal
`normalize(f.file) + "|" + (f.category ?? "")`, where `normalize` lowercases the
path string (the same normalization `findingKey` applies). A finding without a
`file` SHALL have no surface key and SHALL be excluded from surface clustering (it
remains subject to the exact-key and ceiling guards). Two findings that share the
same normalized file and the same `category` SHALL share a surface key regardless
of their `findingKey`, severity, line, or title.

#### Scenario: Same file and category, different keys — same surface

- **WHEN** two findings share the same `file` and the same `category`
- **AND** their `findingKey` values differ (different line band or severity)
- **THEN** `surfaceKey` SHALL return the same string for both findings

#### Scenario: Same file, different category — different surfaces

- **WHEN** two findings share the same `file` but carry different `category` values
- **THEN** `surfaceKey` SHALL return different strings for the two findings

#### Scenario: Finding without a file — no surface

- **WHEN** a finding has no `file` (or an empty `file`)
- **THEN** `surfaceKey` SHALL return no surface key for it
- **AND** the finding SHALL be excluded from surface clustering

### Requirement: Per-round blocking surfaces SHALL be emitted and extracted by a pure, injection-robust marker

`formatReviewComment` SHALL embed a machine-readable
`pipeline-blocking-surfaces` marker recording the `(findingKey, surfaceKey)` pairs
of the round's blocking findings, mirroring the existing `pipeline-blocking-keys`
marker. The marker SHALL be emitted for every `needs-attention` round, including an
empty marker for advisory-only rounds (findings exist but none are blocking), so a
prior advisory-only round cannot seed a false surface streak.

`extractBlockingSurfacesFromComment(body: string)` SHALL be a pure function that
performs no network, git, or subprocess calls and returns the recorded
`(findingKey → surfaceKey)` mapping. The extractor SHALL use a full-line-anchored
regex and SHALL choose the LAST occurrence when multiple markers appear in the
body (guarding against a reviewer-authored marker placed before the real
pipeline-emitted footer marker). For a body with no marker, or a malformed/empty
body, it SHALL return an empty mapping without throwing.

#### Scenario: Marker round-trips emit to extract

- **WHEN** `formatReviewComment` emits a `pipeline-blocking-surfaces` marker for a round with blocking findings
- **AND** `extractBlockingSurfacesFromComment` is called on that comment body
- **THEN** it SHALL return a mapping containing exactly the `(findingKey → surfaceKey)` pairs of that round's blocking findings

#### Scenario: Advisory-only round emits the empty surfaces marker

- **WHEN** a needs-attention round has findings but none are blocking
- **THEN** the comment SHALL contain an empty `pipeline-blocking-surfaces` marker
- **AND** `extractBlockingSurfacesFromComment` SHALL return an empty mapping for that body

#### Scenario: Spoofed marker before the footer — last occurrence wins

- **WHEN** a comment body contains a full-line `pipeline-blocking-surfaces` marker in reviewer-authored content BEFORE the real pipeline-emitted footer marker
- **THEN** `extractBlockingSurfacesFromComment` SHALL use the LAST occurrence and ignore the earlier one

#### Scenario: No marker or malformed body — empty mapping, no throw

- **WHEN** `extractBlockingSurfacesFromComment` is called with a body containing no marker, an empty string, or malformed marker content
- **THEN** it SHALL return an empty mapping without throwing

### Requirement: The surface-recurrence guard SHALL fire on N consecutive same-surface new-key rounds

The review stage SHALL compute, for each surface present in the current round's
blocking findings, a **consecutive-round streak**: `1` for the current round plus
the number of immediately-prior consecutive Review-N rounds whose
`pipeline-blocking-surfaces` marker carries that surface. The guard SHALL fire for
a surface when both:

1. `streak(surface) >= review_policy.surface_recurrence_rounds`, and
2. the current round contributes at least one `findingKey` to that surface that was
   NOT present in the immediately-prior round's mapping for that surface (a *new*
   key — the exact-repeat case is owned by the exact-key early park).

When `review_policy.surface_recurrence_rounds` is `0`, the guard SHALL be disabled
and SHALL NOT fire. The streak computation SHALL be pure set/string arithmetic over
markers the pipeline itself emits and SHALL NOT make a model call. A finding on a
surface that is not carried across consecutive rounds (different `(file, category)`
each round) SHALL keep a streak of `1` and SHALL NOT trigger the guard.

#### Scenario: Three rounds of new keys on the same surface — guard fires

- **WHEN** three consecutive review rounds each emit a blocking finding on the same `(file, category)` surface with a *different* `findingKey` each round
- **AND** `review_policy.surface_recurrence_rounds` is `3`
- **THEN** at the third round the surface's streak SHALL be `3`, the new-key condition SHALL hold, and the guard SHALL fire for that surface

#### Scenario: Distinct surfaces across rounds — guard does not fire

- **WHEN** three consecutive review rounds each emit a blocking finding on a *different* `(file, category)` surface
- **AND** `review_policy.surface_recurrence_rounds` is `3`
- **THEN** every surface's streak SHALL be `1` and the guard SHALL NOT fire

#### Scenario: Streak below threshold — guard does not fire

- **WHEN** a surface has carried a blocking finding for only `2` consecutive rounds
- **AND** `review_policy.surface_recurrence_rounds` is `3`
- **THEN** the guard SHALL NOT fire for that surface

#### Scenario: Guard disabled at zero

- **WHEN** `review_policy.surface_recurrence_rounds` is `0`
- **THEN** the surface-recurrence guard SHALL NOT fire regardless of streak

### Requirement: The exact-key recurrence early park SHALL be evaluated first and remain unchanged

The surface-recurrence guard SHALL be evaluated only after the exact-key recurrence
early park (`review-loop-recurrence`) has been evaluated and did not park. An exact
finding-key repeat SHALL therefore continue to park at `needs-human` via the
existing exact-key guard before the surface guard runs, and the exact-key guard's
behavior SHALL be unchanged by this capability.

#### Scenario: Exact repeat parks before the surface guard runs

- **WHEN** a blocking finding's `findingKey` recurs in the immediately-prior round
- **THEN** the exact-key recurrence early park SHALL transition to `needs-human` first
- **AND** the surface-recurrence guard SHALL NOT alter that outcome

### Requirement: A fired surface guard SHALL route the cluster through the configured ceiling_action terminal and SHALL never auto-demote high or critical findings

When the surface guard fires, its action SHALL mirror
`review_policy.ceiling_action` and SHALL never auto-demote findings whose severity
rank is `high` or `critical`:

- Under `ceiling_action: park` (default), the pipeline SHALL post the
  recurrence-style ceiling punch-list and transition to `needs-human` early,
  without consuming the remaining round budget, and SHALL NOT auto-advance.
- Under `ceiling_action: demote_and_advance`, the pipeline SHALL keep any
  `high`/`critical` findings in the fired cluster blocking, demote only the
  **below-high** findings to advisory with an audited disposition, capture the
  demoted findings in the single tracked follow-up issue, and advance — reusing the
  existing demote-and-advance machinery (`review-ceiling-demote-and-advance`).

#### Scenario: Fired guard under park early-parks at needs-human

- **WHEN** the surface guard fires and `review_policy.ceiling_action` is `park`
- **THEN** the pipeline SHALL transition to `needs-human` and SHALL NOT consume the remaining round budget or auto-advance

#### Scenario: Fired guard under demote_and_advance demotes below-high and advances

- **WHEN** the surface guard fires with only below-high blocking findings in the cluster and `review_policy.ceiling_action` is `demote_and_advance`
- **THEN** the below-high findings SHALL be demoted to advisory with audited dispositions, captured in one follow-up issue, and the item SHALL advance to the normal next stage

#### Scenario: High or critical finding in a fired cluster is never auto-demoted

- **WHEN** the surface guard fires for a cluster that contains a `high`- or `critical`-severity blocking finding
- **THEN** that finding SHALL NOT be demoted by the surface guard
- **AND** it SHALL continue through the normal blocking path (parking at `needs-human` per existing behavior)
