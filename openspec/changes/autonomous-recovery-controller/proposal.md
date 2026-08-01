## Why

`pipeline:loop` currently converts every child `blocked` label into a human-answer hold even
though the repository already ships a typed recovery policy, budgets, and durable attempt ledger.
The v1.29.2 incident left all seven items held, all recovery budgets untouched, and no terminal
loop event; mechanical failures therefore become operator work by construction.

## What Changes

- Introduce one provider-neutral recovery disposition derived from a closed reason-code enum.
- Reserve human holds for explicit current product/authority decisions; ambiguous and mechanical
  failures remain engine-owned.
- Extend the whole-item loop response with typed blocker/recovery evidence instead of collapsing
  all blocked labels to `blocked_needs_human`.
- Wire recovery-policy recipe execution into the production supervisor before hold/stop
  classification, with durable keyed attempts, budget consumption, restart-safe re-entry, and
  sibling continuation.
- Prefer deterministic state/gate/engine redispatch before configured-implementer repair, and make
  authentication recovery a real live-actor verification rather than a placeholder action.
- Route the default single-issue host command through the same durable supervisor used by
  multi-item loops.
- Add a shared mechanical-remediation transaction that can rematerialize the worktree, invoke the
  configured implementer, validate/commit/push the repair, and re-enter the child pipeline.
- Emit real diagnostics for recoverable OpenSpec archive and artifact-validation failures; do not
  emit `human_intervention` for engine-owned work.
- Observe fresh live issue/PR state after blocked dispatches and before any recovery/hold/terminal
  decision, and always write a terminal loop event when the driver exits terminally.
- Treat Claude, Codex, Grok, and extension adapters as configuration and fixtures only; no
  provider-specific recovery branch is introduced.

## Capabilities

### New Capabilities
- `autonomous-recovery-controller`: Canonical reason disposition, recipe execution, durable
  attempts, generic remediation, and the genuine-human boundary.

### Modified Capabilities
- `durable-blocker-classification`: Recovery executes before terminal classification and failed
  attempts consume their bounded budget.
- `pipeline-loop-facade`: Whole-item responses carry typed recoverable or human-authority evidence.
- `durable-loop-supervisor`: Production cycles execute and resume durable recovery actions.
- `loop-needs-human-blocker-disposition`: Only explicit current product/authority decisions create
  holds; a blocked label alone is insufficient.
- `durable-run-reconciliation`: Blocked dispatch outcomes are bound to fresh live identity before
  hold, recovery, remote-proving completion, or stop.
- `openspec-integration`: Validation/archive failures expose exact machine diagnostics and enter
  bounded artifact repair before exhaustion.
- `unified-planning-phase-runner`: Post-revision validation emits exact typed recovery evidence
  instead of granting human authority for a mechanical error.
- `pre-merge-fix-round`: Preflight/rematerialization does not consume the single implementer repair
  attempt; attempt identity is keyed to authoritative state.

## Impact

This changes the loop execution contract additively, the blocker event schema additively, and the
supervisor's production control flow. It affects `pipeline-run`, loop recovery/supervision,
OpenSpec wrappers, worktree remediation, run-store summaries, generated plugin mirrors, and their
spec/test suites. It does not widen merge, deploy, credential, release, or override authority.
