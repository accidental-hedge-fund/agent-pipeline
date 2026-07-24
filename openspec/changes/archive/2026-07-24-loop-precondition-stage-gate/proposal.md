## Why

The first live in-repo supervisor run (`loop-07d05fcd68f7db98`, milestone
`v1.27.0 — Trace-Driven Eval Engineering`) admitted issue #535 into its work list
while the issue still carried `pipeline:backlog`. `/pipeline` correctly refuses to
start work on a pre-`ready` item, so the advance loop made **0 transitions in 3s** and
left the issue at `pipeline:backlog`. The supervisor's dispatch-outcome mapping treats
"issue is still open, not ready-to-deploy, not blocked, not closed" as `failed`, and
the classifier turns `failed` into the `workflow-engine-defect` blocker class whose
policy is `run_fatal`. The whole two-item run durably stopped on item 1 of 2 for a
condition that is a normal, expected pre-pipeline no-op — not an engine defect.

Because the run id is derived deterministically from the resolved issue list
(`workListRunId` = `sha256(repo:engine:issues)[:16]`), the terminal `run_fatal` stop
also **permanently wedges the selector**: every re-invocation of `pipeline loop
--milestone …` over the same items resolves to the same run id, resumes the stopped
run, and re-reports the stop. There is no CLI surface to start a fresh run for the same
item list; the only remediation available was to hand-move the durable run directory
aside.

## What Changes

- **Pre-pipeline items are excluded from the executable frontier, non-fatally.** A
  work-list run item that is not yet at the `pipeline:ready` precondition (e.g. still
  `pipeline:backlog`, or carrying no `pipeline:*` label) SHALL be excluded from the set
  of items the supervisor dispatches, with a durable, **non-fatal** `precondition`
  rationale naming the required stage (`pipeline:ready`). The run advances every
  eligible item and reaches its normal terminal condition; it does **not** stop. If an
  operator triages an excluded item to `pipeline:ready` mid-run, a later cycle admits
  it (the gate is evaluated against live truth each reconciliation pass, not frozen at
  compile time).
- **A pre-pipeline no-op dispatch is never classified `workflow-engine-defect`/`run_fatal`.**
  As defense in depth, if an item is nonetheless dispatched and the advance loop leaves
  it still at a pre-pipeline stage label with zero stage transitions, that outcome SHALL
  be recorded as the same non-fatal `precondition` exclusion — never mapped to `failed`
  and never classified `workflow-engine-defect`. A genuine engine defect (a crash, a
  rejected dispatch, or an unrecognized terminal outcome) is unaffected and still
  classified `workflow-engine-defect`.
- **An audited surface to supersede a terminally-stopped run for the same selector.**
  A new `pipeline loop --new-run` SHALL start a fresh durable run for the same resolved
  selector when the canonical run is in a terminal stopped state, recording a
  `supersedes` pointer to the retired run (and a `superseded_by` pointer on the retired
  run) so the audit trail is preserved without an operator hand-moving durable state.
  Superseding a run that is not terminally stopped SHALL be refused.

## Capabilities

### New Capabilities

- `loop-precondition-stage-gate`: pre-pipeline (not-yet-`ready`) work-list items are
  excluded from the executable frontier with a durable non-fatal `precondition`
  rationale, and a pre-pipeline no-op dispatch is never misclassified as an engine
  defect / `run_fatal` stop.
- `loop-run-supersession`: an operator-invoked, audited way to retire a
  terminally-stopped durable run and start a fresh run for the same selector, linked by
  `supersedes`/`superseded_by` pointers.

### Modified Capabilities

<!-- none: the two new capabilities add behavior alongside the existing supervisor,
     scheduler, and blocker-classification specs without changing their stated
     requirements. -->

## Impact

- `core/scripts/pipeline.ts` — `resolveSelectorIssues` / `realDispatchItem` (dispatch
  outcome mapping) and the `loop` CLI option surface (`--new-run`).
- `core/scripts/loop/supervisor.ts` — frontier selection and the Pass 2 dispatch-outcome
  classification.
- `core/scripts/loop/reconcile.ts` — observing each item's live pipeline stage so the
  gate is evaluated against live truth per cycle.
- `core/scripts/loop/store.ts` / `loop/types.ts` — the `precondition` frontier-exclusion
  rationale record and the run `supersedes`/`superseded_by` pointers.
- No change to the `DurableBlockerClass` enum, the `run_fatal` policy for genuine
  defects, or the pipeline's never-merge boundary.
