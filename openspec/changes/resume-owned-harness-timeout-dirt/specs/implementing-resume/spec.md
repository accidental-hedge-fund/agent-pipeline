## MODIFIED Requirements

### Requirement: implementing stage is resumable when commits exist in the worktree

When the orchestrator dispatches stage `implementing` at the start of a run (re-entry, not mid-flight), it SHALL first consult the repo-stable live-planning marker for the issue. If a live process owns the marker, the dispatcher SHALL return a `waiting` outcome whose reason names the live concurrent owner. Otherwise it SHALL check durable harness mutation ownership for an interrupted incomplete implement attempt (see `harness-mutation-ownership`). When ownership shows owned leftovers or an in-flight implement attempt whose holder is dead, the dispatcher SHALL NOT treat commits ahead of base as sufficient to skip the implementer. It SHALL checkpoint owned leftovers when present, then either re-invoke the implementer or, only when the shared implement-deliverable contract reports satisfied and the worktree is clean of unknown product dirt, resume post-implementation steps.

If no live process owns the marker, no interrupted incomplete implement attempt is current, and an existing worktree for the issue has commits ahead of the base branch, it SHALL resume the post-implementation steps — test gate → push → open-or-find PR → transition `implementing → review-1` — without re-planning or re-implementing. If no live process owns the marker AND no worktree with commits exists AND no interrupted owned leftovers remain to checkpoint, the issue is crash-stranded and the dispatcher SHALL restart the planning arc from `ready` (see the crash-stranded recovery requirement) rather than returning `waiting`.

The liveness check SHALL run before the commits-ahead check so that a live cross-domain implementer is never resume-raced.

#### Scenario: re-entry with commits — advances to review-1

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** no live process owns the repo-stable live-planning marker for the issue
- **AND** a worktree exists for the issue with at least one commit ahead of `cfg.base_branch`
- **AND** durable ownership does not show an interrupted incomplete implement attempt with owned leftovers
- **AND** the issue does not carry the `blocked` label
- **THEN** the pipeline SHALL run the test gate, push the branch, create or find the PR, and transition the issue to `review-1`
- **AND** SHALL NOT re-invoke the planning or implementing harness

#### Scenario: re-entry with a live owner — returns waiting (no resume race)

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** the repo-stable live-planning marker is present and its recorded PID is alive
- **THEN** the dispatcher SHALL return `{ advanced: false, status: "waiting" }`
- **AND** the `waiting` reason SHALL name the live concurrent owner rather than "nothing to do at this point"
- **AND** SHALL NOT inspect the worktree, resume post-implementation steps, roll back the label, or restart planning

#### Scenario: resume after unblock — test gate re-runs

- **WHEN** a prior run blocked at `implementing` due to a test-gate failure
- **AND** the operator has fixed the failing tests and committed to the worktree branch
- **AND** the operator runs `--unblock` followed by `/pipeline N`
- **THEN** the pipeline SHALL re-enter the resume path, re-run the test gate, and advance to `review-1` if the gate passes

#### Scenario: resume when gate still fails — re-blocks

- **WHEN** the pipeline resumes at `implementing` with commits in the worktree
- **AND** durable ownership does not show an interrupted incomplete implement attempt with owned leftovers
- **AND** the test gate fails again on the resume attempt
- **THEN** the pipeline SHALL call `setBlocked` with kind `test-gate-exhausted` and SHALL NOT open a PR or transition the stage

## ADDED Requirements

### Requirement: Interrupted incomplete implement SHALL NOT skip the implementer because commits exist

When implementing re-entry finds a dead holder and durable ownership shows an interrupted implement attempt with pipeline-owned leftovers, the dispatcher SHALL checkpoint those leftovers (or run the `checkpoint_owned_harness_dirt` recipe) and SHALL NOT skip the implementer solely because the worktree has commits ahead of `cfg.base_branch`. After checkpoint, if the shared implement-deliverable contract reports unsatisfied, the pipeline SHALL re-invoke the implementer. If the contract reports satisfied, the worktree is clean of unknown product dirt, and relevant gates are green, the pipeline MAY take the post-implementation path without a second empty implementer commit. Format-gate unknown-dirt pre-flight SHALL NOT run against those owned leftovers before checkpoint. Terminal evidence SHALL use disposition `resumed` when the implementer is re-invoked, or `checkpointed` / `recovered` when checkpoint plus deliverable satisfaction continues post-implement.

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
