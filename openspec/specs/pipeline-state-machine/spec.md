# pipeline-state-machine Specification

## Purpose
The label-driven state machine at the heart of the pipeline: the canonical ordered stages an issue traverses, how the orchestrator advances one transition at a time, the terminal state, the opt-in label gate, the blocked state, and the structural never-auto-merge guarantee. Capability-specific stages (e.g. `eval-gate`, review SHA-gating) are refined by their own delta specs; this baseline documents the spine.
## Requirements
### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`

#### Scenario: dispatch routes design-gate
- **WHEN** the current stage label is `pipeline:design-gate`
- **THEN** the orchestrator SHALL call the design-gate stage handler
- **AND** SHALL NOT call any review or `deployReady.finalize()` handler directly

#### Scenario: design-gate is a no-op when the gate is disabled
- **WHEN** the current stage is `design-gate` and `cfg.design_gate.enabled` is `false`
- **THEN** the issue SHALL transition to `review-1` in the same run
- **AND** no harness SHALL be invoked by the stage

#### Scenario: dispatch routes visual-gate
- **WHEN** the current stage label is `pipeline:visual-gate`
- **THEN** the orchestrator SHALL call the visual stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

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

### Requirement: Stranded `planning` and `plan-review` states SHALL be restarted, not waited on

The advance-loop dispatch table SHALL treat the `planning` and `plan-review` stages as crash-stranded when control reaches the dispatch (i.e. the per-issue lock is held by the current process AND no live-planning marker is found for the same repo+issue).

Before performing a rollback, the dispatcher SHALL consult a repo-stable live-planning marker (`/tmp/pipeline-planning-<owner>-<repo>-<N>.live`). If the marker is present and its recorded PID is alive, a concurrent run from a different domain/worktree is actively planning the issue; the dispatcher SHALL return a `waiting` outcome rather than rolling back. If the marker is absent (or its PID is dead/stale), the issue is crash-stranded; the dispatcher SHALL roll the issue back to `ready` via a `transition()` call and restart the planning arc by calling `planningStage.advance()`, identical to the path taken when the issue is on `ready`.

The `planningStage.advance()` function SHALL set the marker to the current PID before starting any label transitions, and SHALL clear the marker in a `finally` block so that crash-exit also removes the marker.

The dispatcher SHALL log a one-line diagnostic before performing the rollback: `[pipeline] #N: recovered stranded planning attempt — restarting from ready`

#### Scenario: stranded `planning` restarts without operator intervention

- **WHEN** an issue carries `pipeline:planning` and the advance loop acquires the per-issue lock and enters the dispatch table
- **AND** the repo-stable live-planning marker is absent (no active process)
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call with a message referencing the crash recovery
- **AND** SHALL invoke `planningStage.advance()` as if the issue had been on `ready`
- **AND** SHALL print `[pipeline] #N: recovered stranded planning attempt — restarting from ready` before the rollback

#### Scenario: stranded `plan-review` is treated identically

- **WHEN** an issue carries `pipeline:plan-review` and the advance loop acquires the per-issue lock and enters the dispatch table
- **AND** the repo-stable live-planning marker is absent
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call
- **AND** SHALL invoke `planningStage.advance()` to restart the full planning arc from scratch

#### Scenario: concurrent planning still blocked by the lock (same domain)

- **WHEN** process A holds the per-issue lock and is actively planning issue N
- **AND** process B attempts `pipeline N` for the same issue N and same domain
- **THEN** process B SHALL fail at lock acquisition and SHALL NOT reach the dispatch table
- **AND** SHALL print the existing "lock held by another process" error

#### Scenario: concurrent planning from a different domain is detected via the live marker

- **WHEN** process A is actively planning issue N under domain `domain-A`
- **AND** process B uses a different domain `domain-B` (different worktree basename) for the same repo and issue N, acquires its own domain-B lock, and reaches the dispatch table
- **THEN** process B SHALL check the repo-stable live-planning marker
- **AND** SHALL find the marker set by process A with a live PID
- **AND** SHALL return `{ status: "waiting" }` without rolling back or starting a new planning arc

#### Scenario: loop advance outcome on recovery is not `waiting`

- **WHEN** the dispatch table processes a stranded `planning` or `plan-review` issue and `planningStage.advance()` succeeds
- **THEN** the returned `Outcome` SHALL have `advanced: true`
- **AND** the transition count SHALL increment (the run is not a 0-transition no-op)

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

### Requirement: The CLI SHALL recognize `intake` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `intake` as a recognized positional sub-command keyword alongside `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `intake` (case-sensitive), the CLI SHALL dispatch to the intake handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `intake` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `intake` dispatches without an issue number

- **WHEN** the user runs `pipeline intake --description "..."`
- **THEN** the CLI SHALL dispatch the intake handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `intake` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `intake` in the list of recognized sub-command keywords alongside peer no-issue-number modes

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

### Requirement: The CLI SHALL recognize `sweep` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `sweep` as a recognized positional sub-command keyword alongside `intake`, `roadmap`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `sweep` (case-sensitive), the CLI SHALL dispatch to the sweep handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `sweep` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `sweep` dispatches without an issue number

- **WHEN** the user runs `pipeline sweep`
- **THEN** the CLI SHALL dispatch the sweep handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `sweep` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `sweep` in the list of recognized sub-command keywords alongside peer no-issue-number modes

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

### Requirement: The CLI SHALL recognize `backfill` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `backfill` as a recognized positional sub-command keyword alongside `intake`, `sweep`, `roadmap`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `backfill` (case-sensitive), the CLI SHALL dispatch to the backfill handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `backfill` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `backfill` dispatches without an issue number

- **WHEN** the user runs `pipeline backfill`
- **THEN** the CLI SHALL dispatch the backfill handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `backfill` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `backfill` in the list of recognized sub-command keywords alongside peer no-issue-number modes

#### Scenario: Unrecognized sub-command listing includes `backfill`

- **WHEN** the user runs an unrecognized non-digit positional such as `pipeline unknowncmd`
- **THEN** the CLI SHALL exit non-zero with an error listing the recognized no-issue-number sub-commands, including `backfill`

### Requirement: The CLI SHALL recognize `queue` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `queue` as a recognized positional sub-command keyword alongside `intake`, `sweep`, `roadmap`, `release`, `scoreboard`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `queue` (case-sensitive), the CLI SHALL dispatch to the queue handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `queue` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `queue` dispatches without an issue number

- **WHEN** the user runs `pipeline queue`
- **THEN** the CLI SHALL dispatch the queue handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `queue` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `queue` in the list of recognized sub-command keywords alongside peer no-issue-number modes

### Requirement: Ready dispatch records planning substages separately

When an issue starts at `pipeline:ready`, the pipeline SHALL transition the issue to `pipeline:planning` before any long-running planning work, worktree bootstrap, or harness invocation begins. The run artifacts SHALL record separate stage lifecycle entries for `planning`, `plan-review`, and `implementing` when those substages run inside the compound planning flow. The outer `ready` dispatch SHALL NOT record one wrapper lifecycle entry whose duration covers plan review and implementation.

#### Scenario: Planning label set before authoring
- **WHEN** an issue labelled `pipeline:ready` enters the planning flow
- **THEN** the pipeline SHALL transition it to `pipeline:planning` before invoking the planning harness
- **AND** a planning harness failure SHALL block the issue at `planning`, not `ready`

#### Scenario: Compound planning flow emits substage lifecycle
- **WHEN** one advance invocation performs planning, plan-review, and implementation work from a `ready` issue
- **THEN** `events.jsonl` SHALL contain separate `stage_start` and `stage_complete` pairs for `planning`, `plan-review`, and `implementing`
- **AND** the evidence bundle SHALL contain separate stage records for those substages
- **AND** it SHALL NOT contain a single `planning` stage record that wraps the whole compound flow

### Requirement: Fix rounds enforce stale OpenSpec deltas before push

When a fix round changes implementation files after the latest OpenSpec spec-delta update, and the latest structured review verdict includes `category: spec-divergence`, the pipeline SHALL block the fix round before pushing. The condition SHALL match the existing pre-merge stale-delta guard so false-positive behavior does not broaden.

#### Scenario: Stale delta blocks before fix push
- **WHEN** a fix round produces implementation changes after the latest `openspec/changes/<id>/specs/**` change
- **AND** the latest structured review verdict contains `category: spec-divergence`
- **THEN** the fix round SHALL set a blocker with kind `openspec-stale-delta`
- **AND** it SHALL NOT push the branch

#### Scenario: Updated delta clears fix-round guard
- **WHEN** a fix round updates `openspec/changes/<id>/specs/**` after the latest implementation change
- **THEN** the stale-delta guard SHALL pass
- **AND** the fix round MAY proceed to push if all other gates pass

### Requirement: design-gate SHALL be a model-invoking stage only when it fires

`design-gate` SHALL be included in `MODEL_INVOKING_STAGES` so it participates in per-stage model/effort
routing and external stage-executor assignment. It SHALL NOT be a member of `PROMPT_CONTAINED_STAGES`,
because both the implementer's decision-record emission and the reviewer's challenge round require
repository access. When the gate does not fire, the stage SHALL make no model call despite its
membership in `MODEL_INVOKING_STAGES`.

#### Scenario: design-gate participates in model routing
- **WHEN** `MODEL_INVOKING_STAGES` is inspected
- **THEN** it SHALL contain `design-gate`

#### Scenario: design-gate is not prompt-contained
- **WHEN** `PROMPT_CONTAINED_STAGES` is inspected
- **THEN** it SHALL NOT contain `design-gate`
- **AND** assigning a `model-endpoint` executor to `design-gate` SHALL be rejected at config-parse time

#### Scenario: untriggered gate makes no model call
- **WHEN** the `design-gate` stage runs and the gate does not fire
- **THEN** no model or harness invocation SHALL be recorded for that stage

