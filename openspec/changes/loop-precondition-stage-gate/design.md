# Design

## Context

Root-cause trace for run `loop-07d05fcd68f7db98`:

1. `resolveSelectorIssues` (`core/scripts/pipeline.ts`) resolves a milestone selector to
   the set of open issues in that milestone — filtering **only** by milestone membership.
   It does not consider each issue's `pipeline:*` stage. #535 was in the milestone while
   still carrying `pipeline:backlog`, so it entered the work list.
2. `compileWorkListRun` seeds every resolved issue as a `pending` ledger item. The
   supervisor's scheduler admits `pending` items in list order; #535 was item 1.
3. `realDispatchItem` spawns the per-item advance loop. `/pipeline` starts work at
   `ready`, so a `backlog` item makes 0 transitions and the issue stays at
   `pipeline:backlog`. The outcome mapping is:
   ```
   ready-to-deploy label → ready_to_deploy
   blocked label         → blocked_needs_human
   issue closed          → abandoned
   else                  → failed          // ← backlog lands here
   ```
4. Supervisor Pass 2 maps `failed` → `blockItem(blockerClass: "workflow-engine-defect")`,
   whose recovery policy is `run_fatal`. The run stops terminally on item 1 of 2.
5. `workListRunId` = `sha256(repo:engine:issues)[:16]` is deterministic over the resolved
   list, so every re-invocation resumes the stopped run and re-reports the stop. No CLI
   surface starts a fresh run for the same list.

The observable defect is two-fold: (a) a normal pre-pipeline condition is treated as a
fatal engine defect, and (b) once stopped, the selector is permanently wedged.

## Decision 1 — Exclude, don't auto-promote (option (b) over option (a))

Issue #568 offers two acceptable remedies for admission: (a) triage admitted
`pipeline:backlog` items to `pipeline:ready` at admission, or (b) exclude them from the
frontier with a durable non-fatal `precondition` rationale.

**We choose (b).** `pipeline:backlog` is a deliberate operator hold — it means "not yet
cleared to enter the pipeline." Silently promoting a held item to `ready` at admission
would override operator intent and bypass the triage-authority boundary that
`pipeline triage N --stage ready` exists to enforce (a human decides ready-vs-backlog).
Option (b) surfaces "these items need triage" and proceeds with the rest, keeping the
selector read-only about issue stage. It also composes naturally with live truth: because
the gate is re-evaluated each reconciliation pass, an operator who triages an excluded
item to `ready` mid-run gets it admitted on the next cycle with no run restart.

Trade-off: a milestone whose items are all `backlog` produces a run that advances nothing
and completes with an all-excluded report, rather than doing the operator's triage for
them. That is the correct, least-surprising behavior — the run tells the operator exactly
what to triage instead of guessing.

## Decision 2 — Gate on live truth in the frontier, not at compile time

The exclusion is evaluated where the supervisor already observes live truth each cycle
(the reconciliation pass feeding frontier selection), not frozen into the compiled
contract. Reasons:

- The compiled contract and its `workListRunId` stay a pure function of the **resolved
  issue list**, unchanged. We do not want the run identity to depend on transient stage
  labels (that would fork run ids every time a label flips).
- A mid-run triage (`backlog → ready`) must take effect without recompiling or restarting
  the run.
- The reconcile pass already reads each item's live pipeline state; the stage check is a
  read of data it already has.

An excluded item is recorded with a **non-fatal** `precondition` rationale (item id +
required stage `pipeline:ready` + observed stage). It is not a `blocked` transition and
consumes no recovery budget — it is a frontier exclusion, the same family as "gated on a
blocked dependency," not a failure.

## Decision 3 — Classification safety net at the dispatch-outcome boundary

Even with Decision 2, a pre-pipeline item could in principle reach dispatch (a race where
the label is read before an operator flips it back, or a future caller that bypasses the
frontier). The dispatch-outcome mapping is hardened so a pre-pipeline no-op is never
`failed`:

- `realDispatchItem` distinguishes "advance loop left the item at a pre-pipeline stage
  with zero transitions" (a precondition no-op) from the genuine-defect `else`. The former
  is recorded as the same non-fatal `precondition` exclusion; only a true unrecognized
  terminal state, a rejected dispatch, or a crash remains `failed` →
  `workflow-engine-defect`.
- This keeps the `run_fatal` policy intact for real engine defects (Golden rule 3: rigor
  preserved) while removing the false positive.

Detecting "0 transitions at a pre-pipeline stage" uses signals the dispatch seam already
has: the issue's post-dispatch `pipeline:*` label (still `backlog`/absent) — the same
label read the mapping already performs. No new gh field shapes are guessed
(Golden rule 5).

## Decision 4 — `--new-run` supersession with linked pointers

To retire a terminally-stopped run without hand-moving durable state:

- `pipeline loop --new-run` (with the same selector) is permitted **only** when the
  canonical run for that selector is in a terminal stopped state. It mints a fresh run id
  (the canonical `workListRunId` plus a deterministic supersession suffix, so the new id
  is itself stable and re-resumable), records `supersedes: <retired-run-id>` on the new
  run and `superseded_by: <new-run-id>` on the retired run, and drives the fresh run.
- The retired run's directory and ledger are left intact (audit trail preserved) — nothing
  is deleted or moved.
- `--new-run` against a run that is not terminally stopped is refused with a clear error
  (an active or resumable run must be resumed, not superseded), so the surface cannot be
  used to abandon in-flight work.

The suffix is derived deterministically (e.g. from the count of prior supersessions in the
chain), not from a clock or randomness — `Date.now()`/`Math.random()` are unavailable in
the deterministic paths and would break re-resume of the superseding run.

## Alternatives considered

- **Re-review-on-any-stage gate in the classifier** (map every non-terminal outcome to a
  soft retry): rejected — it would mask genuine engine defects and regress the `run_fatal`
  rigor the pipeline depends on.
- **Auto-promote backlog → ready (option (a))**: rejected per Decision 1.
- **Make the run id include stage labels so a triage forks a new run**: rejected — it
  would spray orphan run directories on every label flip and defeat the deterministic
  resume contract.
