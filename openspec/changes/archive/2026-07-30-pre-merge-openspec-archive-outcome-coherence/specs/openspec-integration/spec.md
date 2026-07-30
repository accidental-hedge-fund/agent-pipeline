## ADDED Requirements

### Requirement: Pre-merge OpenSpec archive and still-active checks SHALL share one active-change set

For a given pre-merge evaluation of a pull request head, the pipeline SHALL derive a single shared set of active OpenSpec change ids (the **shared active-change set**) and use that set for both (1) deciding archive candidates / whether `no-candidates` applies and (2) the post-archive residual still-active guard. The set SHALL include every unarchived change id present on the PR tip — including foreign or stacked changes introduced by merging another branch — not only the issue’s original change id. The pipeline SHALL NOT report `openspec-archive` as `skipped` with reason `no-candidates` when that shared set is non-empty for the same head evaluation, and SHALL NOT advance past the residual guard while any member of that set remains active.

#### Scenario: single active change cannot skip then block in one pass

- **WHEN** pre-merge evaluates a PR head whose shared active-change set is exactly one id `foo`
- **AND** `openspec/changes/foo/` is still active on that head
- **THEN** the archive gate SHALL NOT emit `gate_result` with gate `openspec-archive`, result `skipped`, and reason `no-candidates` for that evaluation
- **AND** the evaluation SHALL either attempt archive for `foo` (succeeding or failing with a named error) or block once with `openspec-invalid` naming `foo`
- **AND** the same evaluation SHALL NOT produce the dual sequence skip/`no-candidates` then residual block for `foo`

#### Scenario: foreign or stacked active change is in the shared set

- **WHEN** the PR tip carries an active path `openspec/changes/foreign-change/…` introduced via merge from another branch
- **AND** the PR tip may also carry this issue’s own active change
- **THEN** `foreign-change` SHALL be a member of the shared active-change set used for archive candidates
- **AND** the residual still-active check SHALL use the same membership rule for `foreign-change`
- **AND** pre-merge SHALL NOT treat the head as `no-candidates` while `foreign-change` remains active

#### Scenario: empty shared set still skips cleanly

- **WHEN** the shared active-change set for the PR head is empty
- **THEN** the archive step MAY record `skipped` with reason `no-candidates`
- **AND** the residual still-active guard SHALL NOT block for active OpenSpec changes

### Requirement: Archive gate pass SHALL name only change ids actually archived

When the pre-merge archive step records a successful archive decision (`gate_result` result `pass` for gate `openspec-archive`), the reason SHALL list only change ids that the step has verified left the active tree (no longer present as `openspec/changes/<id>/` after the archive action for that id, or equivalently no longer in the residual active set derived after archive). The step SHALL NOT list a change id as successfully archived when that id remains active. If the shared active-change set has multiple members and only a subset is actually archived, the step SHALL NOT record `pass` for the full multi-id list; it SHALL fail closed (block) with type `openspec-invalid` (or the established archive-failure kind for CLI/commit failures) and name every still-active residual id plus the operator remedy to run `openspec archive <id>` and push.

#### Scenario: partial multi-archive does not claim full success

- **WHEN** the shared active-change set contains `alpha` and `beta`
- **AND** the archive action moves only `alpha` under `openspec/changes/archive/…`
- **AND** `openspec/changes/beta/` remains active
- **THEN** the archive gate SHALL NOT record `pass` with a reason listing both `alpha` and `beta`
- **AND** the evaluation SHALL block with a reason that names `beta` (and MAY name `alpha` only as archived if needed for clarity, but MUST NOT present `beta` as archived)
- **AND** the blocking reason SHALL include the remedy `openspec archive` for residual id(s)

#### Scenario: full multi-archive pass lists only verified ids

- **WHEN** the shared active-change set contains `alpha` and `beta`
- **AND** both are verified no longer active after archive
- **AND** the archive commit and push succeed as required by existing archive requirements
- **THEN** the archive gate MAY record `pass` with a reason naming `alpha` and `beta`
- **AND** the residual still-active guard SHALL find an empty residual set for those ids

#### Scenario: non-empty active set never skips as no-candidates after archive no-op

- **WHEN** the shared active-change set is non-empty before archive
- **AND** archive CLI calls return success but produce no worktree diff that removes residual active change dirs
- **THEN** the step SHALL NOT record `skipped` with reason `no-candidates`
- **AND** the step SHALL block (or otherwise fail closed) naming residual still-active id(s)

### Requirement: Shared active-change set SHALL be resolved on the reviewed PR head

Before finalizing the shared active-change set used to drive archive attempts, the archive step SHALL complete the existing archive-base sync (fetch and fast-forward the worktree to the reviewed `origin/<branch>` head when a worktree is used). Candidate membership for archive attempts SHALL NOT be frozen solely from a pre-sync stale worktree view that omits active changes present on the reviewed head. When the worktree cannot be synced to the reviewed head, the step SHALL keep the existing fail-closed base-sync block and SHALL NOT emit `no-candidates` for that failure.

When no on-disk worktree is available for the issue, the pipeline SHALL resolve the shared active-change set from the reviewed PR-head tree (for example via the GitHub repository contents/tree API at the PR head SHA) and SHALL NOT treat cumulative PR changed-file path subtraction (active paths minus archive paths) as proof that no active change remains. If tip-tree membership cannot be resolved, the step SHALL fail closed rather than emit `no-candidates`.

#### Scenario: stacked change present only after fast-forward is still a candidate

- **WHEN** the local worktree is behind `origin/<branch>`
- **AND** the reviewed head introduces an active OpenSpec change id not present on the stale local HEAD
- **THEN** after archive-base sync succeeds, that id SHALL appear in the shared active-change set used for archive attempts
- **AND** the step SHALL NOT skip with `no-candidates` solely because the pre-sync worktree lacked the change

#### Scenario: missing worktree archive-then-reintroduce is not masked by path subtraction

- **WHEN** no on-disk worktree exists for the issue
- **AND** the reviewed PR head tree still has active path `openspec/changes/foo/`
- **AND** the cumulative PR changed-file list also includes an archive path for `foo` (so active-minus-archive subtraction would be empty)
- **THEN** the shared active-change set SHALL include `foo`
- **AND** the archive step SHALL NOT record `skipped` with reason `no-candidates`
- **AND** the residual still-active guard SHALL NOT treat the head as free of active OpenSpec changes

### Requirement: Residual active-change blocker text SHALL name each id and the archive remedy

When pre-merge blocks because one or more OpenSpec changes remain active on the PR head after archive evaluation, the blocker reason SHALL name each still-active change id and SHALL tell the operator to run `openspec archive <id>` for each and push before pre-merge can continue. The blocker type SHALL remain `openspec-invalid` for this residual-active case (consistent with the living pre-merge contract).

#### Scenario: residual block lists every still-active id

- **WHEN** the residual still-active set after archive evaluation is `foo` and `bar`
- **THEN** pre-merge SHALL call `setBlocked` with type `openspec-invalid`
- **AND** the reason text SHALL include both `foo` and `bar`
- **AND** the reason text SHALL include the operator action to run `openspec archive` for residual id(s) and push
