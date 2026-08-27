## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`needs-spec` SHALL sit between `backlog` and `ready`. It is an admission hold, not a delivery stage: the orchestrator SHALL NOT start planning or implementation from it. Dispatch SHALL wait the way `backlog` waits. It SHALL NOT be a member of `TERMINAL_STAGES`. Gate behavior is specified by the `issue-implementation-readiness-gate` capability.

`pre-code-attestation` (#575) SHALL sit between `plan-review` and `implementing`. It is always
present in the graph, but it is inert unless `pre_code_attestation.enabled` is true and a risk
trigger matches: when disabled or untriggered it SHALL advance toward `implementing` with a
recorded reason and without a human attestation hold. Gate behavior is specified by the
`pre-code-attestation` and `pre-code-design-dossier` capabilities. It SHALL NOT replace
`plan-review` or `design-gate`.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

`needs-human` SHALL appear in `STAGES` as the terminal off-ramp entry (after `ready-to-deploy` in the
constant order). It is not a happy-path successor of `ready-to-deploy`; it is a park state the
advance loop may enter from review-ceiling and similar exhaustion paths. Its resume and status
surfaces are specified by the `needs-human-status-surface` and override-related capabilities.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `needs-spec`, `ready`, `planning`, `plan-review`, `pre-code-attestation`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`, `needs-human`
- **AND** `needs-spec` SHALL appear at an index greater than `backlog` and less than `ready`
- **AND** `pre-code-attestation` SHALL appear at an index greater than `plan-review` and less than `implementing`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`
- **AND** `needs-human` SHALL appear after `ready-to-deploy` in the constant order
- **AND** `needs-human` SHALL be a member of `TERMINAL_STAGES`
- **AND** `needs-spec` SHALL NOT be a member of `TERMINAL_STAGES`

#### Scenario: dispatch routes needs-spec as a wait
- **WHEN** the current stage label is `pipeline:needs-spec`
- **THEN** the orchestrator SHALL NOT invoke planning or implementation
- **AND** SHALL NOT create a worktree
- **AND** the outcome SHALL be a non-advancing wait that tells the operator to apply a spec and re-admit with `pipeline triage <N> --stage ready`

#### Scenario: dispatch routes pre-code-attestation
- **WHEN** the current stage label is `pipeline:pre-code-attestation`
- **THEN** the orchestrator SHALL call the pre-code attestation stage handler
- **AND** SHALL NOT call the implementing handler in the same transition until the stage advances

#### Scenario: disabled pre-code-attestation is a no-op pass-through
- **WHEN** the current stage is `pre-code-attestation` and `cfg.pre_code_attestation.enabled` is `false`
- **THEN** the issue SHALL transition toward `implementing` in the same run
- **AND** no human attestation SHALL be required by this stage

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

### Requirement: Opt-in via the pipeline label gate
The pipeline SHALL act only on issues that already carry a `pipeline:<stage>` label. An issue with no such label SHALL be refused — the run exits without dispatching any stage and explains how to opt in (add `pipeline:ready`). `backlog` and `needs-spec` are triage/admission markers only; the orchestrator starts delivery work at `ready`. When `issue_readiness.enabled` is `true`, a `ready` issue still MUST pass the shared issue-implementation-readiness gate before that delivery work starts.

#### Scenario: issue without a pipeline label
- **WHEN** the orchestrator resolves an issue that carries no `pipeline:*` label
- **THEN** it SHALL refuse to advance
- **AND** SHALL NOT invoke any stage handler

#### Scenario: current stage resolved from the label
- **WHEN** an issue carries `pipeline:review-1`
- **THEN** the orchestrator SHALL begin at stage `review-1`

#### Scenario: needs-spec does not start delivery
- **WHEN** an issue carries only `pipeline:needs-spec`
- **THEN** the orchestrator SHALL NOT start planning or implementation
- **AND** SHALL NOT create a worktree

### Requirement: Planning label precedes harness invocation

The planning stage SHALL transition the issue `ready → planning` (set the `pipeline:planning`
label) BEFORE invoking any planning *authoring* harness, so the label reflects active work for the entire
harness duration rather than leaving the issue on `pipeline:ready` until authoring finishes.

When `issue_readiness.enabled` is `true`, ready dispatch SHALL complete the shared issue-implementation-readiness evaluation (or reuse a bound verdict) while the issue is still on `pipeline:ready`. That admission call uses the Implementer planning treatment and is not the planning authoring harness. After a `ready` verdict, the `ready → planning` transition SHALL still occur before authoring, worktree bootstrap, or the planning delivery harness. After `needs_spec`, `gate-unavailable`, or `mutation-failed`, the issue SHALL NOT transition to `planning`. A `stale-dispatch` result SHALL be a non-advancing wait: the issue SHALL NOT transition to `planning` and SHALL NOT gain `pipeline:needs-spec`.

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

#### Scenario: admission evaluation may run on ready

- **WHEN** `issue_readiness.enabled` is `true` and ready dispatch evaluates a freshly fetched issue
- **THEN** the Implementer planning-treatment admission call MAY run while the issue still carries `pipeline:ready`
- **AND** a `needs_spec` result SHALL NOT call the artifact-authoring harness
- **AND** a `ready` result SHALL still transition `ready → planning` before the artifact-authoring harness

#### Scenario: stale-dispatch does not start planning

- **WHEN** `issue_readiness.enabled` is `true`
- **AND** ready dispatch receives a `stale-dispatch` result because the live stage is no longer `ready`
- **THEN** the issue SHALL NOT transition to `planning`
- **AND** SHALL NOT gain `pipeline:needs-spec`
- **AND** the outcome SHALL be a non-advancing wait

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

### Requirement: Ready dispatch records planning substages separately

When an issue starts at `pipeline:ready` and is admitted for delivery, the pipeline SHALL transition the issue to `pipeline:planning` before any long-running planning work, worktree bootstrap, or planning-authoring harness invocation begins. When `issue_readiness.enabled` is `true`, ready dispatch SHALL finish the shared gate (fresh fetch, evaluate or reuse) before that transition. A `needs_spec`, `gate-unavailable`, or `mutation-failed` outcome SHALL NOT record planning substages and SHALL NOT create a worktree.

The run artifacts SHALL record separate stage lifecycle entries for `planning`, `plan-review`, and `implementing` when those substages run inside the compound planning flow. The outer `ready` dispatch SHALL NOT record one wrapper lifecycle entry whose duration covers plan review and implementation.

#### Scenario: Planning label set before authoring
- **WHEN** an issue labelled `pipeline:ready` enters the planning flow
- **THEN** the pipeline SHALL transition it to `pipeline:planning` before invoking the planning harness
- **AND** a planning harness failure SHALL block the issue at `planning`, not `ready`

#### Scenario: Compound planning flow emits substage lifecycle
- **WHEN** one advance invocation performs planning, plan-review, and implementation work from a `ready` issue
- **THEN** `events.jsonl` SHALL contain separate `stage_start` and `stage_complete` pairs for `planning`, `plan-review`, and `implementing`
- **AND** the evidence bundle SHALL contain separate stage records for those substages
- **AND** it SHALL NOT contain a single `planning` stage record that wraps the whole compound flow

#### Scenario: Rejected ready dispatch does not emit planning substages
- **WHEN** `issue_readiness.enabled` is `true`
- **AND** ready dispatch returns `needs_spec`
- **THEN** the run SHALL NOT record `planning` stage_start
- **AND** SHALL NOT create a worktree
