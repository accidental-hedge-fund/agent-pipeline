## MODIFIED Requirements

### Requirement: Package 3 SHALL make release independently complete

`pipeline release VERSION` SHALL validate one nonempty matching milestone and freshly prove every issue has a merged implementation PR contained in origin/main. It SHALL prepare or reuse version metadata in a dedicated worktree and merge it before freezing C. It SHALL run and validate `runProductionExactCandidateFrg` at C, create or verify a non-force annotated `vVERSION` tag at C with exact notes, and wait for both successful exact-head `release.yml` execution and a non-draft GitHub Release.

Completed retries SHALL reconcile tag C before mutable main or milestone state and SHALL create no fixtures, tag, or release. Unknown and ambiguous observations fail closed.

#### Scenario: Complete release orders authority

- **WHEN** metadata is not integrated for a valid milestone
- **THEN** metadata is prepared and merged before C is frozen
- **AND** exact-candidate FRG passes before tag creation
- **AND** tag creation precedes verified publication

#### Scenario: Completed release survives later main movement

- **WHEN** an exact annotated tag and successful published release already identify C
- **AND** docs refresh or later work advanced main
- **THEN** invoking the same explicit version returns complete without milestone validation, fixtures, retagging, or another publication

### Requirement: Package 3 SHALL preserve bounded preparation and delegate ship

Factory and merge-queue callers SHALL retain an explicit prepare-only surface that cannot finish, tag, or publish. SemVer ship SHALL perform ordinary train integration and then call the same complete release seam exactly once. Continuous ship SHALL stop after integration. Neither release nor SemVer ship completion SHALL install, promote, deploy, or retarget the released tag.

#### Scenario: SemVer ship delegates once

- **WHEN** SemVer train integration completes
- **THEN** ship invokes complete release once and accepts its post-metadata candidate C
- **AND** ship performs no separate FRG, finish, tag, publication, promotion, installation, or deployment orchestration
