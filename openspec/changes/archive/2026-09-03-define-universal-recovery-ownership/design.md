## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- RecoverySupervisor vocabulary in `CONTEXT.md` (#1323). This change is the living-spec law. It does not invent a second owner.
- `core/scripts/command-form-inventory.ts` (`COMMAND_FORM_INVENTORY`, #1329). Two axes already classify every mutating form. `OPERATION_SURFACE` stays the host catalog.
- `typed-request-resolution` and `core/scripts/grill-settle.ts` (`settleRecommendation`, #1326). Public union is already `DecisionRequest | CapabilityRequest | AuthorityRequest`.
- `operation-invariant-reconciliation` and `core/scripts/loop/reconcile.ts` (#1324). Observers and candidate epochs already exist.
- `universal-fault-recovery-matrix` (#1333). Mechanical fixtures already require Cooling rather than false-human or ownerless terminals.
- Remaining conflicting living requirements: `pipeline-state-machine` label terminals, `durable-loop-engine` run-level terminal stops, `durable-blocker-classification` terminal system-failure on exhaustion, `bounded-auto-loop` needs-human park on budget death, and `human-intervention-taxonomy` kind descriptions that still imply a `needs-human` authority transition.

Engine-dogfood bar:

1. **Class, not site.** The class is mechanical, unknown, malformed, process-death, no-progress, capacity, or retry-exhaustion faults becoming terminal or human-looking holds. A mole on one command is incomplete.
2. **Shared law.** Lifecycle state, classifier, recipe exhaustion, and compatibility projections change together.
3. **Next identical fault.** A later supervised command that hits the same class MUST stay owned through RecoverySupervisor. Classifier and lifecycle-state tests catch it. A new mole issue is not required.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: a living lifecycle-state law that consumes RecoverySupervisor, `COMMAND_FORM_INVENTORY`, `settleRecommendation`, and the observer catalog. Do not add a second supervisor, inventory, classifier, or observer package.
- Name and supersede the remaining conflicting terminal/human requirements.
- Keep `STAGES` / `TERMINAL_STAGES` as the label inventory. Map those labels onto lifecycle states instead of deleting them.
- Keep historical `ledger.stop.reason` values as compatibility projections so `--resume` of old runs still has a handle.

**Non-Goals:**

- A second scheduler, RecoverySupervisor, grant schema, or public lifecycle CLI verb.
- Merge authority inside ordinary advance.
- Weakening review, test, release, or deployment gates.
- Encoding known provider failures as architecture.
- Reimplementing #1323 (observations), #1325 (episode persistence / fenced takeover), #1329 (inventory), or #1333 (fault matrix).
- Deleting `pipeline:needs-human` from `STAGES`.

## Decisions

### D1 — Closed lifecycle states; labels stay projections

Record exactly six lifecycle states on the Logical Operation: `active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, `cancelled`.

Keep `pipeline:needs-human` and `pipeline:blocked` as compatibility projections. `TERMINAL_STAGES` remains `{ready-to-deploy, needs-human}` so stage-inventory drift guards and operator docs stay aligned with code constants. Lifecycle ownership is RecoverySupervisor state, not that set.

Alternative considered: remove `needs-human` from `TERMINAL_STAGES`. Rejected: that is a label-inventory break and forces every drift guard, README count, and host doc to change without improving ownership. Projection plus supersession is the first holding rung.

### D2 — Consume the existing inventories; do not add a fourth execution class

The issue's "typed answer or authority operation" is the existing `authority_requirement` axis (`typed-response` | `protected-authority`), not a fourth `execution_disposition`. `COMMAND_FORM_INVENTORY` already classifies every mutating `OPERATION_SURFACE` verb.

This change adds a contract that no lifecycle mutation remains an undocumented carve-out. It does not add `pipeline inventory` or a YAML sidecar.

Alternative considered: reclassify `OPERATION_SURFACE` itself. Rejected: `CONTEXT.md` and #1329 keep it as the host catalog. Mode forms (`--dry-run`, `--apply`, `status`) are not rows there.

### D3 — Historical stop reasons remain projections; live first record is Cooling

Do not delete `run_fatal`, `recovery_exhausted`, or `repeated_no_progress` from the ledger vocabulary in this change. Live first records of those classes enter Cooling (or an external-condition wait). Historical `ledger.stop` remains the `--resume` handle.

Live drive MUST NOT halt independent siblings or synthesize human ownership from those records. Operator `--resume` remains the wake for historical projections. Cooling eligibility and external-condition probes are additional wakes, not a second scheduler.

Alternative considered: delete `ledger.stop` now. Rejected: existing resume tests and operator runbooks key on that field. Projection-then-Cooling is the first holding rung. #1325 owns durable episode persistence.

### D4 — Typed-input wait is owned, not a lifecycle terminal

A current `DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest` is `typed-input-wait`. The operation stays owned. Compatibility `needs-human` / `waiting` / `paused` may project. Those labels are not cancellation and not success.

Recommendation-first auto-settle and candidate-bound authority stay in `typed-request-resolution`. This change only binds those requests onto the lifecycle state set and forbids raw failures from becoming any of them.

Alternative considered: keep "terminal human-authority stop" language in `durable-blocker-classification`. Rejected: that phrase is what lets exhaustion look like a human terminal. Rename the policy outcome to typed-input wait.

### D5 — Process stop is not lifecycle exit

`MAX_ITERATIONS`, auto-loop budgets, host STOP, and `run_complete` may end a process. They do not mark `succeeded` or `cancelled`. Incomplete-invocation messaging stays. Pre-merge `ci-exhausted` stays a mechanical compatibility block, now explicitly Cooling.

Independent siblings continue. This already exists for genuine human holds; it now applies to mechanical exhaustion too.

### D6 — Site specs that still say "park at needs-human" for mechanical faults are superseded by class law

This change rewrites the policy/controller specs named in the proposal. It does not rewrite every stage-local "park" sentence (`design-gate` rematerialize, `visual-gate`, salvage, and peers). Those sites remain bound by `recovery-lifecycle-ownership` and the static/classifier guards. A path-local mole that parks mechanical exhaustion as human ownership fails those guards without a new issue.

## Risks / Trade-offs

- **[Risk] Label inventory vs lifecycle vocabulary confuses operators.** → Mitigation: durable docs and `CONTEXT.md` state that `needs-human` is a compatibility projection of typed-input wait. Drift guards keep `TERMINAL_STAGES` membership unchanged.
- **[Risk] Historical `ledger.stop` still looks terminal to old consumers.** → Mitigation: keep the field; live treatment is Cooling; resume paths stay. Do not require consumers to understand a new public verb.
- **[Risk] Independent-sibling continuation after former run-level stops increases concurrency.** → Mitigation: existing item isolation, merge barriers, and issue-run locks remain. This change does not widen lock scope or add a second scheduler.
- **[Risk] Overlap with #1323 / #1325 implementation.** → Mitigation: this change is spec law plus hermetic contract tests. Episode persistence, observation types, and fenced takeover stay on those issues.
- **[Risk] Auto-loop budget-exhaustion comments currently teach operators to treat the park as needs-human.** → Mitigation: rewrite the handoff as Cooling evidence. `--override` applies only to a later typed request or governed finding.

## Migration Plan

1. Land the living-spec deltas and the closed lifecycle-state contract tests.
2. Map live `run_fatal` / `recovery_exhausted` / `repeated_no_progress` / cycle-cap exits onto Cooling without deleting historical `ledger.stop` fields.
3. Stop writing human-owned `needs-human` for mechanical exhaustion. Keep the label for current typed-input waits.
4. Align operator docs and `openspec/project.md` language.
5. Rollback: revert the spec change. Historical ledgers remain readable because stop-reason strings are unchanged.

## Open Questions

None. Sequencing with #1323 and #1325 is decided: this change is the law; those issues persist observations and episodes.
