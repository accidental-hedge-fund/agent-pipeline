# review-surface-recurrence Specification

## Purpose
TBD - created by archiving change review-surface-recurrence-guard. Update Purpose after archive.

## Requirements

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
The review stage SHALL compute a surface streak only from trusted Review-N comments eligible under
`review-loop-recurrence`: verified prior-run review output followed by that run's production
`review-N -> fix-N -> actual-next-stage` transition pair and proven candidate movement. Unmarked,
duplicate, same-SHA, or transition-incomplete comments SHALL NOT extend the streak.

For each current blocking surface, the streak is `1` plus consecutive eligible prior rounds carrying
the surface. The guard SHALL fire when the streak reaches
`review_policy.surface_recurrence_rounds` and the current round contributes a key absent from the
immediately-prior eligible mapping. A value of `0` disables the guard. Computation SHALL remain pure
marker arithmetic without a model call.

#### Scenario: Three eligible repaired rounds on one surface fire the guard
- **WHEN** three Review-N attempts separated by verified production repair cycles and candidate movement carry different blocking keys on the same surface
- **AND** `surface_recurrence_rounds` is `3`
- **THEN** the third review SHALL fire the surface guard

#### Scenario: Unrepaired surface history is ignored
- **WHEN** older pipeline runs contain matching surface markers without completed repair cycles
- **THEN** the guard SHALL NOT fire from those comments

#### Scenario: Distinct surfaces do not fire
- **WHEN** consecutive eligible rounds carry different `(file, category)` surfaces
- **THEN** every surface streak SHALL remain below the threshold

#### Scenario: Zero disables the guard
- **WHEN** `surface_recurrence_rounds` is `0`
- **THEN** the surface guard SHALL NOT fire

### Requirement: The exact-key recurrence early park SHALL be evaluated first and remain unchanged
The exact-key recurrence decision SHALL be evaluated before the surface guard. When every blocker
is an exact eligible recurrence, the stage SHALL enter typed `review-findings` mechanical recovery
before surface evaluation. It SHALL NOT transition to `needs-human`. When any blocker is new, exact
recurrence SHALL not intercept the verdict and the surface or normal fix routing may evaluate it.

#### Scenario: Exact recurrence enters recovery before surface evaluation
- **WHEN** every blocking finding repeats an eligible immediately-prior key
- **THEN** the stage SHALL block as `review-findings` with recover disposition
- **AND** the surface guard SHALL NOT alter that outcome

#### Scenario: Mixed exact and new blockers continue
- **WHEN** a verdict contains both an exact recurrence and a new blocking key
- **THEN** exact recurrence SHALL NOT park the item
- **AND** the new work SHALL retain normal fix routing

### Requirement: A fired surface guard SHALL route the cluster through the configured ceiling_action terminal and SHALL never auto-demote high or critical findings
The pipeline SHALL route a fired surface guard without inventing human authority. When the guard fires for all current blockers, `demote_and_advance` MAY demote only below-high
findings through the existing audited follow-up path. A high/critical fired finding, or any fired
finding under `ceiling_action: park`, SHALL remain blocking and enter canonical `review-findings`
mechanical recovery rather than human authority. When non-fired new blockers are co-batched with a
fired surface, the entire set SHALL route to `fix-N`; the fired subset SHALL NOT cause the new
blockers to park or be demoted.

#### Scenario: Fired park policy enters recovery
- **WHEN** the surface guard fires for all blockers and `ceiling_action` is `park`
- **THEN** the stage SHALL block with canonical `review-findings` recovery
- **AND** SHALL NOT transition to `needs-human`

#### Scenario: Below-high fired cluster can demote and advance
- **WHEN** the guard fires for all blockers, all are below high, and `ceiling_action` is `demote_and_advance`
- **THEN** the findings SHALL be audited, deferred to one follow-up, and advanced

#### Scenario: High fired finding remains blocking and recoverable
- **WHEN** a fired cluster contains a high or critical blocker
- **THEN** that finding SHALL NOT be demoted
- **AND** the stage SHALL enter typed mechanical recovery without human intervention

#### Scenario: Mixed fired and new blockers route to fix
- **WHEN** a fired surface is co-batched with a blocker outside the fired surfaces
- **THEN** the complete blocking set SHALL route to `fix-N`

### Requirement: A settled-surface evidence rule SHALL distinguish recurrence from a newly discovered defect

The pre-merge delta gate MAY demote a blocking finding for lacking new HEAD-state evidence only when the finding matches a specific settled finding by stable key or guarded title similarity on the same surface. Surface identity alone SHALL NOT establish recurrence. A distinct high or critical finding discovered in a file and category that previously contained another settled finding SHALL remain blocking and follow normal fix or recovery routing.

#### Scenario: New high finding shares a settled surface

- **WHEN** a delta review reports a high finding on the same file and category as a settled finding
- **AND** the new finding does not match the settled finding by stable key or guarded title similarity
- **THEN** the new finding SHALL remain blocking even when its body contains no quoted HEAD-state evidence
- **AND** the gate SHALL NOT emit an empty blocking-key set or advance on the strength of surface identity alone

#### Scenario: Specific settled finding is re-raised without evidence

- **WHEN** a delta review re-raises the same settled finding by stable key or guarded title similarity on the same surface
- **AND** its body contains no current HEAD-state evidence
- **THEN** the existing settled-finding advisory routing MAY apply
- **AND** the audit event SHALL identify the specific settled finding that matched

#### Scenario: Post-auto-fix residual remains authoritative

- **WHEN** the bounded pre-merge auto-fix produces a new exact candidate SHA
- **AND** the immediate re-review reports a blocking residual or a newly discovered blocker
- **THEN** that post-fix verdict SHALL remain blocking without historical settled-surface or advisory carry-forward demotion
