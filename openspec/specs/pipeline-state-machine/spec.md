# pipeline-state-machine Specification

## Purpose
The label-driven state machine at the heart of the pipeline: the canonical ordered stages an issue traverses, how the orchestrator advances one transition at a time, the terminal state, the opt-in label gate, the blocked state, and the structural never-auto-merge guarantee. Capability-specific stages (e.g. `eval-gate`, review SHA-gating) are refined by their own delta specs; this baseline documents the spine.
## Requirements
### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`
- **AND** `eval-gate` SHALL appear at an index greater than `pre-merge` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`

#### Scenario: dispatch routes eval-gate
- **WHEN** the current stage label is `pipeline:eval-gate`
- **THEN** the orchestrator SHALL call the eval stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

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
The pipeline SHALL NOT merge pull requests from the autonomous `advance` loop. There is no merge stage in `STAGES` and no merge command anywhere in the orchestrator or stage handlers; the terminal stage is `ready-to-deploy`. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying `auto_merge` as an unknown key (see `pipeline-configuration`). The never-auto-merge guarantee is structural — enforced at config parse time, not run time.

A human-invoked `pipeline merge <pr>` sub-command exists as a separate, loop-isolated surface. This sub-command is never called by the advance loop and does not weaken the structural guarantee; it is the controlled, explicit mechanism by which a human (or pipeline-desk on a human button click) performs a merge after the pipeline reaches `ready-to-deploy`. See the `merge-sub-command` capability for its requirements.

#### Scenario: auto_merge key is rejected at config parse time
- **WHEN** a repo sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key
- **AND** the pipeline SHALL NOT run

#### Scenario: advance loop never invokes the merge handler
- **WHEN** the advance loop dispatches any stage transition (from `ready` through `ready-to-deploy`)
- **THEN** no call to the `pipeline merge` handler or any symbol from `merge.ts` is made
- **AND** the loop terminates at `ready-to-deploy` without merging the PR

### Requirement: Blocked state halts the advance loop

When an issue carries the `blocked` label (`BLOCKED_LABEL = "blocked"`), the advance loop SHALL stop and surface the latest blocker comment — except at `implementing`, where auto-recovery is attempted first; if recovery succeeds the loop continues, otherwise it stops. The "## Pipeline: Blocked" comment posted by `setBlocked` SHALL render a kind-specific "### How to unblock" section drawn from the `BlockerKind` enum and the `BLOCKER_RECIPES` map; the section SHALL NOT use the generic `--unblock` instruction for blocker classes where `--unblock` is not the correct recovery verb.

When an issue at `implementing` is **not** blocked but the dispatch table is entered at that stage (re-entry at the start of a run), the pipeline SHALL check for a resumable worktree before returning "nothing to do" — see the `implementing-resume` capability.

#### Scenario: blocked issue stops the loop

- **WHEN** the current issue carries the `blocked` label at `review-1`
- **THEN** the loop SHALL stop and surface the blocker rather than dispatching the stage

#### Scenario: blocked comment contains kind-specific recipe

- **WHEN** `setBlocked` is called with `kind = "test-gate-exhausted"`
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** the section SHALL NOT instruct the operator to run `--unblock`

#### Scenario: implementing dispatch with commits — resumes rather than waits

- **WHEN** the advance loop dispatches stage `implementing` at the start of a run (re-entry)
- **AND** the issue does NOT carry the `blocked` label
- **AND** a worktree with commits ahead of the base branch exists for the issue
- **THEN** the dispatcher SHALL invoke the implementing-resume path rather than returning `{ status: "waiting" }`

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

### Requirement: needs-human is resumable via --override without manual relabeling

The `needs-human` stage SHALL be resumable by the `--override` path without the operator manually relabeling the issue. When `--override` is invoked on an item at `needs-human`, the pipeline SHALL read the target review round from the `## Pipeline: Review ceiling reached` comment, flip the label from `pipeline:needs-human` to `pipeline:review-<round>`, and enter the advance loop. The advance loop's `needs-human` break point (for non-override entry) SHALL remain unchanged — only the `--override` code path performs the automatic flip.

#### Scenario: --override on needs-human reads round from ceiling comment

- **WHEN** an operator invokes `--override` on an item at stage `needs-human`
- **AND** the item has a `## Pipeline: Review ceiling reached` comment encoding `round: N`
- **THEN** the pipeline SHALL flip the label to `pipeline:review-N` before entering the advance loop
- **AND** SHALL NOT require the operator to relabel manually

#### Scenario: advance loop still breaks on needs-human without --override

- **WHEN** the advance loop reaches `needs-human` via normal stage progression (not via `--override`)
- **THEN** the loop SHALL break and surface the ceiling comment, unchanged from prior behavior
- **AND** SHALL NOT attempt to flip the label automatically

### Requirement: The CLI SHALL recognize `roadmap` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `roadmap` as a recognized positional sub-command keyword alongside `intake`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `roadmap` (case-sensitive), the CLI SHALL dispatch to the roadmap handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `roadmap` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `roadmap` dispatches without an issue number

- **WHEN** the user runs `pipeline roadmap`
- **THEN** the CLI SHALL dispatch the roadmap handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `roadmap` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `roadmap` in the list of recognized sub-command keywords alongside peer no-issue-number modes

### Requirement: The CLI SHALL recognize `triage` as a sub-command keyword that accepts an issue number

The pipeline CLI dispatch block SHALL accept `triage` as a recognized positional sub-command keyword alongside `intake`, `release`, `sweep`, `roadmap`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `triage` (case-sensitive), the CLI SHALL dispatch to the triage handler — passing the second positional argument as the issue number and the `--stage` flag value — without entering the stage-advance loop and SHALL NOT advance any pipeline stage label via the state machine. The string `triage` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `triage` dispatched before the advance loop

- **WHEN** the user runs `pipeline triage 42 --stage ready`
- **THEN** the CLI SHALL dispatch the triage handler
- **AND** SHALL NOT enter the advance loop or call any stage handler from the STAGES sequence
- **AND** SHALL NOT read or write any pipeline stage label through the state machine

#### Scenario: `triage` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `triage` in the sub-command listing alongside peer keywords such as `intake`, `release`, `sweep`, and `roadmap`

### Requirement: The CLI positional dispatch block SHALL recognize `refine-spec` as a no-issue-number sub-command

The pipeline CLI positional-argument dispatch block SHALL recognize `refine-spec` as a valid no-issue-number keyword alongside existing peers (`init`, `doctor`, `release`, `intake`, `triage`, `sweep`, `merge`). When the first positional argument is `refine-spec`, the orchestrator SHALL dispatch the refine-spec handler and SHALL NOT attempt to resolve an issue number, read a stage label, or advance the pipeline state machine.

#### Scenario: `refine-spec` dispatched without issue number

- **WHEN** the user runs `pipeline refine-spec --title "T" --body "B"`
- **THEN** the orchestrator dispatches the refine-spec handler
- **AND** does NOT attempt to resolve an issue number
- **AND** does NOT read or write any `pipeline:*` stage label

#### Scenario: `refine-spec` listed in help text

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the command listing alongside `intake`, `release`, and peer sub-commands

### Requirement: shipcheck-gate handler SHALL invoke the auto-merge eligibility gate when enabled
After completing its existing checks, the `shipcheck-gate` handler SHALL invoke the auto-merge eligibility gate module if `config.auto_merge_eligibility.enabled` is `true`. The eligibility gate runs inline inside `shipcheck-gate`; it does NOT introduce a new entry in the `STAGES` constant. The `shipcheck-gate` handler SHALL advance to `ready-to-deploy` regardless of the eligibility verdict — the gate produces a classification artifact only and does not block stage progression.

#### Scenario: eligibility gate runs inside shipcheck-gate when enabled
- **WHEN** the `shipcheck-gate` handler is dispatched
- **AND** `config.auto_merge_eligibility.enabled` is `true`
- **THEN** the handler SHALL call the eligibility gate module after all existing checks complete
- **AND** SHALL write the `auto_merge_eligibility` artifact to the evidence bundle
- **AND** SHALL still advance the issue to `ready-to-deploy` regardless of the eligibility verdict

#### Scenario: eligibility gate skipped inside shipcheck-gate when disabled
- **WHEN** the `shipcheck-gate` handler is dispatched
- **AND** `config.auto_merge_eligibility.enabled` is `false` (the default)
- **THEN** the handler SHALL NOT call the eligibility gate module
- **AND** SHALL advance to `ready-to-deploy` exactly as before

#### Scenario: eligibility gate error does not block ready-to-deploy
- **WHEN** the eligibility gate throws an unexpected error
- **THEN** the `shipcheck-gate` handler SHALL log the error
- **AND** SHALL still advance to `ready-to-deploy`
- **AND** SHALL NOT propagate the error as a stage failure

### Requirement: Planning label precedes harness invocation

The planning stage SHALL transition the issue `ready → planning` (set the `pipeline:planning`
label) BEFORE invoking any planning harness, so the label reflects active work for the entire
harness duration rather than leaving the issue on `pipeline:ready` until authoring finishes.

While the planning stage is executing — from the moment it begins until it transitions to
`plan-review` (when plan review is enabled) or `implementing` (when it is not) — any block it
raises SHALL classify the stage as `planning`, never `ready`. This applies to every
planning-stage block path: worktree-creation failure, worktree-setup failure, plan-generation
(artifact authoring) failure, and OpenSpec structural-validation failure.

This requirement governs only the planning-stage label timing and the stage classification of
planning-stage blocks. The `planning → plan-review` and `planning → implementing` transitions,
and any blocks raised after the `plan-review` transition (which are classified `plan-review`),
are unaffected.

#### Scenario: planning label is set before the authoring harness runs

- **WHEN** the planning stage begins for an issue on `pipeline:ready` (not a dry run)
- **THEN** the stage SHALL transition `ready → planning` before calling the artifact-authoring
  harness
- **AND** the authoring harness SHALL observe the issue already on `pipeline:planning`

#### Scenario: planning-stage blocks classify the stage as planning

- **WHEN** a block is raised while the planning stage is executing (before the `plan-review`
  or `implementing` transition) — for any of: worktree-creation failure, worktree-setup
  failure, plan-generation failure, or OpenSpec validation failure
- **THEN** `setBlocked` SHALL be called with stage `planning`
- **AND** SHALL NOT be called with stage `ready`

#### Scenario: downstream transitions are unaffected

- **WHEN** the planning stage authors a valid artifact and plan review is enabled
- **THEN** it SHALL transition `planning → plan-review` and later `plan-review → implementing`
  exactly as before
- **WHEN** plan review is disabled
- **THEN** it SHALL transition `planning → implementing` directly, exactly as before

