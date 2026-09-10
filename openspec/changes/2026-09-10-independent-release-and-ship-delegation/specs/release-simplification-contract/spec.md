## MODIFIED Requirements

### Requirement: Package 3 SHALL make release independently complete

`pipeline release VERSION` SHALL validate one nonempty matching milestone and freshly prove every issue has a merged implementation PR contained in origin/main. It SHALL prepare or reuse version metadata in a dedicated worktree and merge it before freezing C. Every open, newly merged, or already merged metadata PR reuse path SHALL prove the same release-managed changed-file scope, requested version in both root and `core/package.json`, immutable PR head identity, nonempty green CI at that exact head, merge result, and containment in C, including when GitHub has deleted the PR source branch. It SHALL run and validate `runProductionExactCandidateFrg` at C, create or verify a non-force annotated `vVERSION` tag at C with exact notes, and wait for verified execution of the one `release.yml` publisher and a matching non-draft GitHub Release.

A version string that is merely present on origin/main SHALL fail closed unless that same common validator has proved a release-managed metadata PR for VERSION. Closed issues or `pipeline:ready-to-deploy` labels alone SHALL NOT prove integration.

After metadata CI and merge, release SHALL freshly re-resolve and validate the milestone and containment proof against frozen C before creating fixtures. It SHALL revalidate that proof and unchanged C after FRG and immediately before irreversible tag creation.

Completed retries SHALL reconcile tag C before mutable main or milestone state and SHALL create no fixtures, tag, or release. A tagged retry is bound to C only when package versions at C, exact annotation, authoritative reconstruction of the exact-pair FRG pass for C, the exact successful publisher run, and the matching non-draft publication agree. FRG completion SHALL be re-observed from forge issue/PR identity and provenance, exact-head CI, review and Tester evidence, current-head readiness, and no-merge facts; an ignored local record MAY bind or accelerate lookup but SHALL NOT prove any of those facts. From a fresh or cleaned checkout, a tagged retry SHALL discover and validate exactly one existing pair without invoking the fixture creator or runner; missing, ambiguous, or unverifiable authoritative evidence fails closed rather than creating a replacement pair.

An interrupted publication SHALL remain anchored to proven C rather than rebinding to later main or rerunning fixtures. After a tag exists at C, observable origin/main movement that blocks publication SHALL report a durable tagged-stale-C incomplete result: no retag, no tag delete, no fixture recreation, and no rebinding to later main. That incomplete result SHALL remain distinct from a completed annotated tag plus successful non-draft publication whose later docs refresh advanced main.

`release.yml` SHALL be the single publication and recovery owner. Publisher recovery SHALL use one durable state machine keyed by workflow identity `release.yml` plus exact tag plus exact C, classifying remote runs as absent, pending, failed, or successful. Observation of that remote run set SHALL query the workflow-run API for `release.yml` plus exact candidate SHA and paginate to completion. A truncated or incomplete page SHALL fail closed. Absence MAY be concluded only after that exact-identity set is proven complete. Bounds SHALL come from that remote run set, not from local process flags. The CLI SHALL persist a recovery episode keyed by that same workflow, tag, and C before issuing a missing-run dispatch, and SHALL reload it on a later invocation. When that episode records an unobserved dispatch and exhaustive remote observation is still absent, recovery SHALL wait rather than dispatch again. An exact-C push or recovery-dispatch run may receive at most one rerun when remote evidence shows it failed and has not already been rerun. A missing exact-identity run may receive one bounded exact-C recovery `workflow_dispatch` to that same workflow after re-verifying the remote annotated tag, and only while origin/main still equals C. The CLI SHALL NOT implement a second Release creator/editor. Release absence may be concluded only from a status-aware authoritative not-found response for that exact tag; authentication, authorization, network, rate-limit, malformed response, and 5xx failures are unknown and fail closed.

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
- **AND** origin/main still equals C
- **THEN** release reconstructs the passed exact-pair result from authoritative forge, exact-head CI, review, Tester, readiness, and no-merge observations and verifies exact package and annotation identity for C
- **AND** it resumes only the exact tag publisher/publication path without consulting later main, creating fixtures, or retagging
- **AND** it behaves identically in a fresh checkout with no local FRG record
- **AND** missing, conflicting, or unknown authoritative proof fails closed

#### Scenario: Tagged stale-C stays incomplete without retag

- **WHEN** an exact annotated tag exists at C
- **AND** origin/main no longer equals C
- **AND** the matching non-draft GitHub Release is not yet a verified success
- **THEN** release reports a durable tagged-stale-C incomplete result
- **AND** it does not create fixtures, retag, force-move, or delete the tag
- **AND** that result remains distinct from a completed tag whose later docs refresh advanced main

#### Scenario: Publisher recovery retains one owner

- **WHEN** the exact annotated tag at C is proven but its exact publisher run failed or is absent
- **AND** origin/main still equals C
- **THEN** release classifies the remote `release.yml` runs for that exact tag and C as absent, pending, failed, or successful
- **AND** that classification paginates the exact-identity workflow-run set to completion rather than treating a 100-row page as the complete set
- **AND** it reruns or boundedly dispatches `release.yml` for that exact tag and C using remote evidence as the only bound
- **AND** a missing-run dispatch is recorded in a durable recovery episode before the workflow run, and a later invocation with that episode still absent waits instead of dispatching again
- **AND** `release.yml` re-verifies the remote annotated tag identity before creating or editing the Release
- **AND** no CLI-side or second workflow publication implementation is used

#### Scenario: Unknown Release state is not absence

- **WHEN** observing the Release fails for any reason other than an authoritative exact-tag not-found response
- **THEN** neither the CLI nor `release.yml` creates a Release
- **AND** the release remains incomplete with the unknown observation reported

#### Scenario: Metadata reuse preserves the full gate

- **WHEN** an existing metadata PR is open, becomes merged while observed, or was already merged
- **THEN** release proves its exact head changes only release-managed files and sets both root and core versions to VERSION
- **AND** it proves at least one nonempty green CI result belongs to that exact immutable head
- **AND** it proves the resulting merge commit is contained in frozen C before fixtures

#### Scenario: Metadata reuse survives deleted source branch

- **WHEN** the metadata PR is already merged and GitHub has deleted `release/vVERSION`
- **THEN** release still retrieves exact-head paths, both package versions, nonempty exact-head CI, merge identity, and containment from forge PR identity plus Git fetch of `pull/N/head` or the merge commit
- **AND** it does not treat a missing head branch as missing provenance
- **AND** a version string present on main without that validated PR proof fails closed

### Requirement: Package 3 SHALL preserve bounded preparation and delegate ship

Factory and merge-queue callers SHALL retain an explicit prepare-only surface that cannot finish, tag, or publish. The prepare-only map SHALL be: `pipeline release prepare VERSION`; `pipeline factory-release prepare --request`; and `pipeline merge-queue --release-when-complete`. `pipeline release finish <pr>` SHALL remain a metadata-PR merge helper and SHALL NOT tag or publish. Preparation SHALL use a dedicated worktree and SHALL never align, switch, or edit the invoking checkout. `release prepare VERSION --packed-candidate SHA` SHALL reject during argument validation before any Git command. SemVer ship SHALL perform ordinary train integration and then call the same complete release seam exactly once. Continuous ship SHALL stop after integration. Neither release nor SemVer ship completion SHALL install, promote, deploy, or retarget the released tag. Ordinary `advance`, `single`, and `loop` SHALL NOT acquire merge or tag authority through this change.

#### Scenario: SemVer ship delegates once

- **WHEN** SemVer train integration completes
- **THEN** ship invokes complete release once and accepts its post-metadata candidate C
- **AND** ship performs no separate FRG, finish, tag, publication, promotion, installation, or deployment orchestration

#### Scenario: Packed preparation is caller-safe

- **WHEN** `release prepare VERSION --packed-candidate SHA` is requested
- **THEN** the command rejects during argument validation before any Git mutation
- **AND** the invoking checkout's HEAD, branch, index, and worktree remain unchanged

#### Scenario: Prepare-only callers stay bounded

- **WHEN** `release prepare`, `factory-release prepare`, or merge-queue `--release-when-complete` runs
- **THEN** the caller may prepare version metadata only
- **AND** it does not finish, tag, publish, or invoke complete release
- **AND** `advance`, `single`, and `loop` still cannot merge or tag

### Requirement: Package 3 SHALL make the tag boundary maximally observable

Immediately before tag creation, release SHALL freshly observe origin/main equals frozen C and revalidate the milestone after FRG. It SHALL create and push only an exact annotated tag object by a non-force ref creation, then re-fetch and verify the remote tag object, peeled C, notes, and origin/main. Before publication, `release.yml` SHALL independently verify that the remote tag is the expected annotated object at C with exact notes derived from TAG and C, and that origin/main still equals C. If any observation differs or is unknown, publication SHALL fail closed. A nonempty annotation that does not exactly match those required notes SHALL NOT publish. The workflow SHALL check out and verify the intended tag source, including both root and core package versions, before publication; for post-tag docs it SHALL check out the intended current main source before installing dependencies and generating docs.

The supported Git/GitHub primitives do not provide an atomic operation that both conditionally creates a tag and asserts an unrelated protected main ref remains C without updating that branch. Therefore the final-main-observation/tag-create and workflow-main-observation/publication intervals retain an unavoidable distributed race. The implementation SHALL NOT claim compare-and-swap atomicity, force/update main as a surrogate lock, or delete/move a tag after a detected race; it SHALL minimize the interval, perform the independent pre/post checks above, and expose any detected movement as a fail-closed stale-C result for plan review and operator reconciliation.

`release.yml` SHALL accept a recovery `workflow_dispatch` with required inputs `tag` (`vX.Y.Z`) and `candidate` (40-hex C). A recovery dispatch SHALL run the same publication job as the tag-push trigger after validating those inputs against the remote annotated tag at C. It SHALL NOT become a second Release creator or a second docs owner. Dispatch `--ref` SHALL be the exact tag. Status-aware Release lookup in both the CLI and `release.yml` SHALL use an HTTP-status classification equivalent to `isHttp404Signal` plus `isGithubAuthOrPermissionError` in `core/scripts/gh.ts`; only an exact-tag 404 that is not auth-shaped MAY be treated as absence.

#### Scenario: Publisher rejects same-C tag with divergent notes

- **WHEN** the remote annotated tag peels to C and origin/main equals C
- **AND** the annotation does not exactly match the required notes derived from TAG and C
- **THEN** `release.yml` does not create or edit a GitHub Release

#### Scenario: Main moves at the tag boundary

- **WHEN** origin/main differs from C at a pre-tag, post-tag, or pre-publication observation
- **THEN** release does not claim completion and `release.yml` does not publish when the movement is observable before publication
- **AND** an already created tag is never force-moved or deleted
- **AND** the result explicitly reports the distributed race limitation rather than claiming atomic exclusion

#### Scenario: Recovery dispatch uses exact tag and candidate inputs

- **WHEN** remote evidence shows no exact `release.yml` run for tag `vVERSION` at C
- **AND** the remote annotated tag at C is re-verified and origin/main still equals C
- **THEN** release persists a recovery episode keyed by `release.yml`, `vVERSION`, and C before issuing one `gh workflow run release.yml --ref vVERSION -f tag=vVERSION -f candidate=C`
- **AND** the workflow checks out that tag, verifies root and core versions, publishes, then checks out current main before installing dependencies and generating docs
- **AND** a second dispatch is not issued when any exact-identity run already exists
- **AND** a later invocation that still observes no exact-identity run waits on that episode instead of dispatching again
