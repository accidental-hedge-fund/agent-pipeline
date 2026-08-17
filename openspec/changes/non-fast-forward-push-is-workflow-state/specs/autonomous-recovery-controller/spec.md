## ADDED Requirements

### Requirement: Workflow-state recovery for a stale-tip push SHALL rematerialize or fast-forward
When a durable item blocks with class `workflow-state` because a push was rejected as non-fast-forward or the local managed worktree HEAD is behind the open-PR or verified remote head, the first permitted recipe SHALL rematerialize or fast-forward that managed worktree to the open-PR head when an open PR exists, otherwise the verified remote tip. After that currency action succeeds, recovery SHALL clear the mechanical block (when present) and continue the same item. The recipe SHALL NOT be `wait_and_retry`. The recipe SHALL NOT force-push. Existing rematerialize dirty / local-only unpushed refuse rules SHALL still apply when rematerialize would destroy operator work.

#### Scenario: Non-fast-forward loop recipe rematerializes then continues
- **WHEN** a durable item blocks from the #1038 non-fast-forward diagnostic (`workflow-state`, `push-failed`)
- **THEN** the compiled policy SHALL select `resync_workflow_state` (or the equivalent rematerialize / fast-forward recipe) first
- **AND** that recipe SHALL move the managed worktree HEAD to the open-PR or verified remote tip
- **AND** it SHALL NOT select `wait_and_retry`

#### Scenario: Waiting cannot recover a stale tip
- **WHEN** the same #1038 fixture is classified as `workflow-state`
- **THEN** durable projection SHALL NOT yield `transient-rate-limit`
- **AND** the recovery executor SHALL NOT treat elapsed backoff as a successful currency repair

#### Scenario: Dirty or local-only unique work still refuses destroy
- **WHEN** rematerialize or hard reset to the PR / remote head would destroy a dirty or local-only unpushed product candidate
- **THEN** the recipe SHALL refuse that destroy
- **AND** the attempt SHALL fail typed without a force-push
