## MODIFIED Requirements

### Requirement: Package 3 SHALL make release independently complete

`pipeline release VERSION` SHALL validate one nonempty matching milestone and freshly prove every issue has a merged implementation PR contained in origin/main. It SHALL prepare or reuse version metadata in a dedicated worktree and merge it before freezing C. It SHALL run and validate `runProductionExactCandidateFrg` at C, create or verify a non-force annotated `vVERSION` tag at C with exact notes, and wait for both successful exact-head `release.yml` execution and a non-draft GitHub Release.

After metadata CI and merge, release SHALL freshly re-resolve and validate the milestone and containment proof against frozen C before creating fixtures. It SHALL revalidate that proof and unchanged C after FRG and immediately before irreversible tag creation.

Completed retries SHALL reconcile tag C before mutable main or milestone state and SHALL create no fixtures, tag, or release. A tagged retry is bound to C only when package versions, exact annotation, a durable passed exact-pair FRG record for C, the exact successful tag publisher run, and the matching non-draft publication agree. An interrupted publication SHALL remain anchored to that proven C rather than rebinding to later main or rerunning fixtures. Unknown and ambiguous observations fail closed.

#### Scenario: Complete release orders authority

- **WHEN** metadata is not integrated for a valid milestone
- **THEN** metadata is prepared and merged before C is frozen
- **AND** exact-candidate FRG passes before tag creation
- **AND** tag creation precedes verified publication

#### Scenario: Completed release survives later main movement

- **WHEN** an exact annotated tag and successful published release already identify C
- **AND** docs refresh or later work advanced main
- **THEN** invoking the same explicit version returns complete without milestone validation, fixtures, retagging, or another publication

#### Scenario: Milestone proof remains fresh across release gates

- **WHEN** metadata exact-head CI and merge complete
- **THEN** release re-resolves milestone membership and merged-PR containment against frozen C before creating fixtures
- **AND** release repeats that read-only validation after FRG immediately before creating the tag
- **AND** any reopened or newly incomplete issue, changed containment proof, or movement from C blocks the next mutation

#### Scenario: Tagged retry preserves exact durable identity

- **WHEN** an exact annotated tag exists at C but publication is incomplete
- **THEN** release requires the durable passed exact-pair FRG record and exact package and annotation identity for C
- **AND** it resumes only the exact tag publisher/publication path without consulting later main, creating fixtures, or retagging
- **AND** missing, conflicting, or unknown durable or remote proof fails closed

### Requirement: Package 3 SHALL preserve bounded preparation and delegate ship

Factory and merge-queue callers SHALL retain an explicit prepare-only surface that cannot finish, tag, or publish. Preparation SHALL use a dedicated worktree and SHALL never align, switch, or edit the invoking checkout; a packed-candidate preparation request SHALL either preserve that isolation or reject before mutating Git state. SemVer ship SHALL perform ordinary train integration and then call the same complete release seam exactly once. Continuous ship SHALL stop after integration. Neither release nor SemVer ship completion SHALL install, promote, deploy, or retarget the released tag.

#### Scenario: SemVer ship delegates once

- **WHEN** SemVer train integration completes
- **THEN** ship invokes complete release once and accepts its post-metadata candidate C
- **AND** ship performs no separate FRG, finish, tag, publication, promotion, installation, or deployment orchestration
