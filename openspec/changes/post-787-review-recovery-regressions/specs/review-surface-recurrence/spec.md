## MODIFIED Requirements

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
