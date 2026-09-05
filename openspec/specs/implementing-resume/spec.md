# implementing-resume Specification

## Purpose
TBD - created by archiving change implementing-resume. Update Purpose after archive.

## Requirements

### Requirement: implementing stage is resumable when commits exist in the worktree

When the orchestrator dispatches stage `implementing` at the start of a run, it SHALL first consult the repo-stable live-planning marker for the issue. If a live process owns the marker, the dispatcher SHALL return a `waiting` outcome naming that owner without inspecting or mutating the worktree. Otherwise it SHALL reconcile durable harness mutation ownership and the current candidate epoch before deciding whether implementation is complete.

Commits ahead of base SHALL be provenance only. The dispatcher SHALL resume the post-implementation sequence only when the shared implement-deliverable observer proves the exact current candidate contains the required product implementation and identifies that evidence as implementation rather than planning. A planning artifact, planning-only salvage or checkpoint commit, merged planning/specification PR, process exit, local ledger state, label, or comment SHALL NOT satisfy that proof. When product implementation is not proved and the worktree can be safely reused, RecoverySupervisor SHALL retain ownership and schedule or invoke the implementation harness for the current epoch. Unknown product dirt and failed ownership checkpointing SHALL retain their existing fail-closed behavior. When no reusable candidate exists, RecoverySupervisor MAY reconstruct the stage through the established restart-from-ready treatment.

#### Scenario: re-entry with commits — advances to review-1

- **WHEN** a pipeline run re-enters `implementing` with no live owner
- **AND** the exact current candidate is ahead of base and authoritatively satisfies the product implementation postcondition
- **AND** ownership reconciliation and cleanliness checks pass
- **THEN** the pipeline SHALL run the required post-implementation gates and publication sequence
- **AND** SHALL NOT re-run planning or implementation solely to manufacture another commit

#### Scenario: reused implementation PR is bound to the admitted operation

- **WHEN** the publication sequence reuses an existing or concurrently created implementation PR
- **THEN** it SHALL verify the PR body is bound to the admitted Logical Operation
- **AND** when the binding is absent it SHALL append the marker and confirm it by re-reading the PR
- **AND** a conflicting or unconfirmed binding SHALL remain RecoverySupervisor-owned and SHALL NOT transition toward review

#### Scenario: Planning-only commit invokes implementation

- **WHEN** a salvaged or ordinary commit ahead of base contains only the accepted OpenSpec or other planning artifact
- **AND** no exact-candidate product implementation postcondition is proved
- **THEN** the pipeline SHALL NOT resume post-implementation, open an implementation PR, or transition to design or review
- **AND** RecoverySupervisor SHALL retain ownership and invoke or schedule the implementation harness

#### Scenario: re-entry with a live owner — returns waiting (no resume race)

- **WHEN** the repo-stable live-planning marker records a live owner for the issue
- **THEN** the dispatcher SHALL return an owned `waiting` outcome
- **AND** SHALL NOT inspect the worktree, resume post-implementation, roll back the label, or restart planning

#### Scenario: Unknown product dirt stays fail closed

- **WHEN** ownership reconciliation leaves unknown product dirt on the candidate
- **THEN** the dispatcher SHALL NOT invoke a product-mutating harness or enter post-implementation publication
- **AND** RecoverySupervisor SHALL retain the existing typed recovery ownership

#### Scenario: resume after unblock — test gate re-runs

- **WHEN** a prior implementing attempt was blocked by the test gate
- **AND** the exact current candidate now has authoritative implementation-role proof and the operator clears the compatibility block
- **THEN** re-entry SHALL run the test gate again before publication
- **AND** SHALL advance only when the current Candidate epoch passes

#### Scenario: resume when gate still fails — re-blocks

- **WHEN** implementing re-entry has authoritative current implementation proof
- **AND** the test gate still fails
- **THEN** the pipeline SHALL report the established test-gate failure under RecoverySupervisor ownership
- **AND** SHALL NOT open a PR or transition toward review

### Requirement: PR is created exactly once across the initial run and any resume runs

When the pipeline resumes at `implementing`, it SHALL attempt to find an existing PR for the issue before creating a new one. If a PR already exists, it SHALL use the existing PR number and SHALL NOT attempt to create a duplicate. The transition comment (`implementing → review-1`) SHALL reference the PR number whether the PR was created in the current run or found from a prior partial run.

#### Scenario: PR already exists — reused on resume

- **WHEN** the resume path runs
- **AND** `getPrForIssue(cfg, issueNumber)` returns a PR number
- **THEN** the pipeline SHALL use that PR number for the transition comment
- **AND** SHALL NOT call `createPr()`

#### Scenario: no existing PR — created during resume

- **WHEN** the resume path runs
- **AND** `getPrForIssue(cfg, issueNumber)` returns null
- **THEN** the pipeline SHALL call `createPr()` and use the returned PR number for the transition comment

### Requirement: crash-stranded implementing stage SHALL restart from ready

When the orchestrator dispatches stage `implementing` at the start of a run and finds that no live process owns the repo-stable live-planning marker AND no worktree with commits ahead of `cfg.base_branch` exists, the dispatcher SHALL treat the issue as crash-stranded. It SHALL roll the label back to `ready` via a `transition()` call, log a one-line recovery diagnostic, and restart the planning arc by calling `planningStage.advance()` — identical to the recovery taken for a stranded `planning` / `plan-review` entry. It SHALL NOT return a `waiting` "nothing to do" outcome and SHALL NOT leave the run as a 0-transition no-op.

The recovery diagnostic SHALL be `[pipeline] #N: recovered stranded implementing attempt — restarting from ready`, printed before the rollback.

Because the live-planning marker is set at the start of `planningStage.advance()` and cleared in a `finally` block covering the whole `ready → review-1` arc (planning, plan-review, and implementing), an absent-or-dead marker at the `implementing` entry proves the run that set `implementing` is no longer alive. The rollback and restart are therefore safe: no live process can be mid-implementation for this issue.

#### Scenario: crash-stranded implementing restarts without operator intervention

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** the repo-stable live-planning marker is absent (or its recorded PID is dead)
- **AND** no worktree with commits ahead of `cfg.base_branch` exists for the issue
- **THEN** the dispatcher SHALL NOT return `{ advanced: false, status: "waiting" }`
- **AND** SHALL print `[pipeline] #N: recovered stranded implementing attempt — restarting from ready` before rolling back
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call referencing the crash recovery
- **AND** SHALL invoke `planningStage.advance()` to restart the full planning arc

#### Scenario: recovery outcome is advancing, not waiting

- **WHEN** the dispatcher recovers a crash-stranded `implementing` issue and `planningStage.advance()` succeeds
- **THEN** the returned `Outcome` SHALL have `advanced: true`
- **AND** the run SHALL NOT be a 0-transition no-op that exits as if healthy

#### Scenario: liveness gate precedes the commits check

- **WHEN** the `implementing` dispatch runs
- **THEN** it SHALL evaluate the live-planning marker before inspecting the worktree for commits ahead of base
- **AND** a live owner SHALL short-circuit to `waiting` without any worktree inspection, rollback, or restart

### Requirement: Post-implementation PR ensure disposes superseded open PRs

The post-implementation path SHALL, after creating or reusing the PR for issue N on the current managed head branch H (exact-head lookup, then create if missing), run supersede disposal for other open PRs associated with N whose head is not H, per the `supersede-issue-prs` capability, before treating ensure-PR as complete for the subsequent `implementing → review-1` transition. Exact-head reuse for H SHALL remain unchanged: when an open same-repo PR already exists for branch H, the path SHALL reuse that PR number and SHALL NOT create a duplicate PR for H. Supersede disposal SHALL run on both the create path and the reuse path so a stale associated PR on a different head is not left open solely because H already had a PR. When supersede disposal reports that the managed PR is **not** the GitHub-elected canonical open managed pipeline PR for N, the path SHALL NOT complete the stage transition as advanced and SHALL NOT treat ensure-PR as success for this concurrent head (so two hosts cannot both advance on PRs that close each other).

#### Scenario: New managed PR closes stale associated PR on other head

- **WHEN** the resume/post-implement path creates PR M for managed head H of issue N
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N under dual strategies on a different head
  with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL close S with a `pipeline-superseded` comment naming M
- **AND** SHALL proceed using M for the transition comment

#### Scenario: Reused managed PR still supersedes other heads

- **WHEN** the resume/post-implement path finds existing PR M for managed head H
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N on a different head with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL reuse M without calling create for H
- **AND** SHALL still dispose S under supersede rules

#### Scenario: Supersede failure does not prevent review-1 transition when managed PR is ready

- **WHEN** managed PR M for head H is successfully created or reused
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** supersede disposal fails for a candidate S
- **THEN** the path SHALL still be allowed to complete ensure-PR and transition
  toward `review-1` with PR M
- **AND** SHALL surface a log/diagnostic for the disposal failure

#### Scenario: Non-canonical concurrent managed PR does not transition

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** supersede disposal reports M is not the GitHub-elected canonical open
  managed pipeline PR for N (another concurrent `pipeline/<N>-*` head won)
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close the elected winning managed PR

#### Scenario: Externally closed managed PR does not transition or dispose siblings

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** the authoritative open-PR list used by supersede disposal omits M on head H
  (for example a human closed M after ensure)
- **AND** another open associated PR S for issue N remains on a different head
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close or supersede-comment S

### Requirement: Interrupted incomplete implement SHALL NOT skip the implementer because commits exist

When implementing re-entry finds a dead holder and durable ownership shows an interrupted implement attempt with pipeline-owned leftovers, the dispatcher SHALL checkpoint those leftovers (or run the `checkpoint_owned_harness_dirt` recipe) and SHALL NOT skip the implementer solely because the worktree has commits ahead of `cfg.base_branch`. After checkpoint, if unknown product dirt remains, the pipeline SHALL set the established unknown-dirt block and SHALL NOT re-invoke the implementer or take the post-implementation path. After checkpoint, if the shared implement-deliverable contract reports unsatisfied and unknown product dirt is empty, the pipeline SHALL re-invoke the implementer. If the contract reports satisfied, the worktree is clean of unknown product dirt, and relevant gates are green, the pipeline MAY take the post-implementation path without a second empty implementer commit. If checkpoint fails and owned leftovers remain, the dispatcher SHALL NOT re-invoke a product-mutating harness and SHALL NOT take the post-implementation path; it SHALL block with kind `harness-failure` and SHALL preserve the existing ownership record. Format-gate unknown-dirt pre-flight SHALL NOT run against those owned leftovers before checkpoint. Terminal evidence SHALL use disposition `rejected` when unknown product dirt remains after checkpoint, `resumed` when the implementer is re-invoked, or `checkpointed` / `recovered` when checkpoint plus deliverable satisfaction continues post-implement.

#### Scenario: Timeout leftovers with an intermediate commit re-invoke implement

- **WHEN** a pipeline run starts at `implementing`
- **AND** no live process owns the marker
- **AND** the worktree has commits ahead of base including an intermediate implement commit
- **AND** durable ownership classifies remaining uncommitted product files as owned leftovers
- **AND** the implement deliverable is not yet satisfied
- **THEN** the pipeline SHALL checkpoint the owned leftovers
- **AND** SHALL re-invoke the implementer
- **AND** SHALL NOT jump to format-gate unknown-dirt refusal without an implementer
- **AND** SHALL NOT open or update the PR solely from the intermediate commit while the deliverable is unsatisfied

#### Scenario: Checkpointed leftovers with satisfied deliverable may continue post-implement

- **WHEN** owned leftovers are checkpointed
- **AND** the shared implement-deliverable contract reports satisfied at HEAD
- **AND** the worktree is clean of unknown product dirt
- **AND** relevant gates pass
- **THEN** the pipeline MAY resume post-implementation steps without re-invoking the implementer
- **AND** SHALL NOT invent an empty implementer commit

#### Scenario: Failed leftover checkpoint does not re-invoke implementer

- **WHEN** implementing re-entry finds owned leftovers
- **AND** checkpoint fails with those leftovers remaining
- **THEN** the dispatcher SHALL NOT re-invoke the implementer
- **AND** SHALL NOT skip to post-implementation solely because commits exist
- **AND** SHALL block with kind `harness-failure`

#### Scenario: Checkpointed leftovers with remaining unknown product dirt do not re-invoke implementer

- **WHEN** owned leftovers are checkpointed
- **AND** unknown product dirt remains
- **THEN** the dispatcher SHALL NOT re-invoke the implementer
- **AND** SHALL NOT skip to post-implementation solely because commits exist
- **AND** SHALL set the established unknown-dirt block for the remaining unknown product paths

### Requirement: Same-process implementing timeout SHALL resume post-implementation when the unpublished commit is publishable

When the implementing harness returns timeout (or equivalent failure) in the same process that still owns the managed worktree, and `unpublished-stage-commit-publish` classifies HEAD as a publishable unpublished stage commit with a satisfied implement deliverable, the engine SHALL take the existing post-implementation path — format and test gates → push → create-or-find PR → transition `implementing → review-1` — without waiting for a later launcher, `recover-parked`, or an operator unblock. This path SHALL be the same post-implementation sequence used on re-entry when commits exist ahead of base. A live concurrent owner of the planning marker SHALL still return `waiting` and SHALL NOT publish.

#### Scenario: Same-process timeout with checkpoint commit publishes

- **WHEN** implementing times out in the process that still holds the worktree
- **AND** a salvage or ownership-checkpoint commit is publishable unpublished
- **AND** the implement deliverable is satisfied
- **AND** no live process other than this one owns the planning marker
- **THEN** the engine SHALL run format and test gates, push, create or find the PR, and transition to `review-1`
- **AND** SHALL NOT return a blocked timeout outcome that leaves the commit unpublished

#### Scenario: Same-process timeout with a pipeline-authored implement tip publishes

- **WHEN** implementing times out in the process that still holds the worktree
- **AND** HEAD is a pipeline-authored implement commit (issue trailers present)
- **AND** the classifier reports a publishable unpublished stage commit
- **AND** this-round `salvaged` and `ownershipCheckpointed` are both false
- **THEN** the engine SHALL take the post-implementation publish path
- **AND** SHALL NOT require a legacy salvage or ownership-checkpoint flag to select publication

#### Scenario: Re-entry after a prior timeout park still publishes

- **WHEN** a prior run parked at `implementing` after timeout with a retained worktree holding the unpublished commit
- **AND** a later `recover-parked` or whole-item re-entry reaches implementing-resume
- **AND** the classifier still matches
- **THEN** the engine SHALL take the same post-implementation path
- **AND** SHALL NOT roll back to `ready` as crash-stranded solely because no PR exists yet

### Requirement: Planning and implementation deliverables SHALL have distinct identities

The pipeline SHALL record or derive a verifiable role and identity for the accepted planning artifact and a separate identity for the implementation candidate. Implementing-stage goal checks SHALL accept only implementation-role evidence bound to the current Candidate epoch. A content match, commit authorship marker, or OpenSpec change path SHALL NOT change a planning artifact into implementation evidence.

#### Scenario: Salvage preserves planning role

- **WHEN** recovery salvages a commit whose material product delta is only the planning artifact
- **THEN** the salvaged commit SHALL remain classified as planning provenance
- **AND** SHALL NOT satisfy the implementing-stage goal

#### Scenario: Candidate replacement requires new implementation proof

- **WHEN** implementation was proved for candidate epoch `E1`
- **AND** the candidate moves to epoch `E2`
- **THEN** the prior implementation proof SHALL be invalid for `E2`
- **AND** post-implementation work SHALL wait until the implementation postcondition is re-proved for `E2`
