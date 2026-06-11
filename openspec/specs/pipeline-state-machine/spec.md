# pipeline-state-machine Specification

## Purpose
The label-driven state machine at the heart of the pipeline: the canonical ordered stages an issue traverses, how the orchestrator advances one transition at a time, the terminal state, the opt-in label gate, the blocked state, and the structural never-auto-merge guarantee. Capability-specific stages (e.g. `eval-gate`, review SHA-gating) are refined by their own delta specs; this baseline documents the spine.
## Requirements
### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `ready-to-deploy`
- **AND** `eval-gate` SHALL appear at an index greater than `pre-merge` and less than `ready-to-deploy`

### Requirement: Terminal stage is ready-to-deploy
`TERMINAL_STAGES` SHALL contain exactly `ready-to-deploy`. When an issue reaches it, the run finalizes and the advance loop stops; no stage follows it.

#### Scenario: reaching the terminal stage
- **WHEN** an issue advances to `ready-to-deploy`
- **THEN** the run SHALL finalize (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and stop
- **AND** no further stage handler SHALL be dispatched

### Requirement: Opt-in via the pipeline label gate
The pipeline SHALL act only on issues that already carry a `pipeline:<stage>` label. An issue with no such label SHALL be refused — the run exits without dispatching any stage and explains how to opt in (add `pipeline:ready`). `backlog` is a triage marker only; the orchestrator starts work at `ready`.

#### Scenario: issue without a pipeline label
- **WHEN** the orchestrator resolves an issue that carries no `pipeline:*` label
- **THEN** it SHALL refuse to advance
- **AND** SHALL NOT invoke any stage handler

#### Scenario: current stage resolved from the label
- **WHEN** an issue carries `pipeline:review-1`
- **THEN** the orchestrator SHALL begin at stage `review-1`

### Requirement: Bounded advance loop
The orchestrator SHALL advance at most `MAX_ITERATIONS` (= 12) transitions per invocation. Each iteration dispatches the current stage and either advances (incrementing a transition count) or stops on a non-advancing outcome (`blocked`, `waiting`, `no-op`, `finalized`, or `error`). Under `--once`, it SHALL stop after a single transition.

#### Scenario: loop stops on a waiting outcome
- **WHEN** a stage returns `{ advanced: false, status: "waiting" }` (e.g. CI still running)
- **THEN** the loop SHALL break and the run SHALL end without error, to be resumed on a later invocation

#### Scenario: iteration cap
- **WHEN** stages keep advancing without reaching a terminal/blocked state
- **THEN** the loop SHALL stop after at most 12 transitions in a single invocation

### Requirement: Never auto-merge (structural guarantee)
The pipeline SHALL NOT merge pull requests. There is no merge stage in `STAGES` and no merge command anywhere in the orchestrator or stage handlers; the terminal stage is `ready-to-deploy`. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying `auto_merge` as an unknown key (see `pipeline-configuration`). The never-auto-merge guarantee is structural — enforced at config parse time, not run time.

#### Scenario: auto_merge key is rejected at config parse time
- **WHEN** a repo sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key
- **AND** the pipeline SHALL NOT run

### Requirement: Blocked state halts the advance loop
When an issue carries the `blocked` label (`BLOCKED_LABEL = "blocked"`), the advance loop SHALL stop and surface the latest blocker comment — except at `implementing`, where auto-recovery is attempted first; if recovery succeeds the loop continues, otherwise it stops.

#### Scenario: blocked issue stops the loop
- **WHEN** the current issue carries the `blocked` label at `review-1`
- **THEN** the loop SHALL stop and surface the blocker rather than dispatching the stage

### Requirement: Review verdict determines the next stage
From a review stage, an `approve` verdict SHALL advance the issue (`review-1` → `review-2`, `review-2` → `pre-merge`) and a `needs-attention` verdict carrying findings SHALL route to the matching fix stage (`review-1` → `fix-1`, `review-2` → `fix-2`).

#### Scenario: review-1 approves
- **WHEN** review-1 returns verdict `approve`
- **THEN** the issue SHALL advance to `review-2`

#### Scenario: review-1 needs attention
- **WHEN** review-1 returns verdict `needs-attention` with at least one finding
- **THEN** the issue SHALL route to `fix-1`

### Requirement: --status is stage-conditionally enriched for needs-human
The `--status` command SHALL print a stage-specific punch-list when the resolved stage is `needs-human`. For all other stages, `--status` output SHALL be identical to the pre-existing behavior.

#### Scenario: status on needs-human stage
- **WHEN** `--status` is invoked
- **AND** the issue carries the `pipeline:needs-human` label
- **THEN** the status output SHALL include the unresolved blocking-finding count and the resume steps (see `needs-human-status-surface`)
- **AND** SHALL exit 0 without any mutation to the issue

#### Scenario: status on all other stages is unchanged
- **WHEN** `--status` is invoked
- **AND** the resolved stage is any value other than `needs-human`
- **THEN** the output SHALL be identical to the pre-change behavior for that stage

