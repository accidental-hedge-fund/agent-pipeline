## Context

See proposal.md — Why. Summary of the mechanical trap:

1. Reconcile `ready_label_present` is **only** `pipeline:ready-to-deploy` (`READY_LABEL` in `loop/reconcile.ts`). Intake-ready `pipeline:ready` does **not** set it.
2. Stage suffix `ready` is **not** mid-flight (`isMidFlightPipelineStage` / #712). Local state + open PR + stage `ready` repair-forwards to ledger `pr_opened` (#511 compatibility path).
3. For aligned `pr_opened` + checks `success`, `computeNextAction` returns `advance`.
4. Supervisor active set = existing `in_progress` only; scheduler admits only `pending` (`selectSchedulableSet` / `eligibleIndependentItems`). Nothing consumes `next_actions.advance` on `pr_opened`.
5. Mid-flight heal restores `pr_opened` → `in_progress` only when stage is mid-flight. Intake-ready never heals → `no_eligible_item` × N → `supervisor_no_progress`.

#712 design Decision 4 explicitly left “residual pure `pr_opened` + non-mid-flight + green checks may still emit `advance`” out of scope. #1068 is that residual becoming a live stop.

Grill-lock (issue comments): `pipeline:ready` = intake-ready, not finished; open PR + ledger `pr_opened` + not R2D = advance-eligible; `supervisor_no_progress` while `next_actions` is `advance` is a bug.

Ship-path constitution: **class over site** — shared classifier/recipe/controller change so the next identical fault does not need a new mole.

## Goals / Non-Goals

**Goals:**

- Make **advance-still-needed** stranded `pr_opened` dispatchable via the same local-state + re-dispatch path as mid-flight heal.
- Close the no-progress false terminal when work is still advertised as `advance`.
- Keep R2D / merged terminal catch-up and `needs-human` off-ramp exclusion.
- Prove with pure + supervisor execution-trace unit tests (injected deps).

**Non-Goals:**

- Building a general multi-action consumer for every `LoopNextAction` (including a dedicated `advance` dispatcher on remote-proving states as the primary path).
- Redefining `pipeline:ready` as ready-to-deploy or changing `ready_label_present` semantics.
- Admitting `pr_opened` into the independent-set `pending` frontier.
- Auto-merge, review demotion, or cross-host lock expansion.
- Changing CI await semantics when checks are still `pending` beyond “heal may re-enter advance which already handles wait/progress.”

## Decisions

### Decision 1 — Class: advance-still-needed heal (generalize #712), not a next_actions.advance dispatcher

**Choice:** Expand the stranded-`pr_opened` restore so reconciliation heals to `in_progress` whenever:

- ledger state is `pr_opened`
- identity has open PR (`pr_number !== null`, `pr_state === "open"`)
- `ready_label_present` is false (not R2D)
- PR is not merged (already covered by open)
- stage is **not** the terminal off-ramp `needs-human`

Mid-flight remains a subset of this class. Intake-ready (`ready`), null stage (crash-after-PR-open residual), and mid-flight all become dispatchable after heal.

**Why not a pure `next_actions.advance` consumer on `pr_opened`:** Living law (`durable-loop-supervisor`) forbids relying on non-consuming `next_actions.advance` for continuity. Happy-path transitions use `pending` → `in_progress` → terminal `ready`. Heal-to-`in_progress` reuses existing re-dispatch without inventing a second work selector.

**Why not only expand the scheduler frontier to include `pr_opened`:** Would mix remote-proving state with admission frontier semantics and still leave no-progress edge cases; heal keeps one dispatch surface.

**Alternatives rejected:** Path-local “if issue == 1065” or “only stage ready” mole — fails class-over-site.

### Decision 2 — Precedence unchanged for terminal catch-up

Strict order before heal:

1. Merged PR → repair-forward to `merged` (no heal).
2. Open PR + `ready_label_present` → repair-forward to ledger `ready` (no heal).
3. Else open PR + advance-still-needed (`pr_opened` + !R2D + not `needs-human`) → heal to `in_progress`.
4. #511 local → `pr_opened` catch-up for non-mid-flight open PR may still run on the **same** pass from local states; a **subsequent** reconcile (or same-pass follow-up if implementable without oscillation) MUST then heal if still not R2D so the item is not left with only dead `advance`. Prefer: heal branch applies whenever current entry state is `pr_opened` after prior catch-up; two-cycle lag is acceptable if the no-progress guard (Decision 4) prevents false terminal in the lag window. Prefer single-pass heal after forward repair when the repaired target is `pr_opened` and advance-still-needed holds — implementers may restructure the reconcile loop to apply heal on the post-mutation state without double-writing history.

### Decision 3 — Keep mid-flight gate for local → pr_opened; do not demote mid-flight locals

Do **not** reverse #712’s gate: mid-flight local states still must not repair-forward to `pr_opened` on open PR alone. This change only expands **restore from** already-`pr_opened` when advance still needed.

#511 scenario “local + open PR at ready → pr_opened” remains true for the catch-up classification; the new requirement is that residual stranded `pr_opened` does not stay non-dispatchable.

### Decision 4 — Supervisor no-progress guard when next_actions is advance

**Choice:** Before recording run stop `supervisor_no_progress` (and, where applicable, when classifying a cycle as pure `no_eligible_item` with no progress), the supervisor SHALL consult the latest reconciliation `next_actions`. If any non-done contract item has `next_actions[id] === "advance"`, the run MUST NOT stop as `supervisor_no_progress` solely from consecutive no-progress / empty active set. Prefer: treat that condition as a programming defect surface — first ensure heal made the item `in_progress` so the next cycle dispatches; the guard is **defense-in-depth** against heal lag or missed restore.

**Progress accounting:** A cycle that heals and then dispatches counts as progress. A cycle that only no-ops while `advance` is still advertised must not accumulate to terminal `supervisor_no_progress` (may continue, await, or surface a typed engine defect if dispatch remains impossible after heal — not silent false terminal).

**Out of scope for this guard:** inventing infinite spin when advance is advertised but identity is contradictory (`ledger-ahead`, etc.) — those project to `noop` / non-advance next actions already.

### Decision 5 — Pure helpers, tests, mirror

- Prefer a pure predicate (e.g. `isAdvanceStillNeededPrOpened(identity)` or expand heal condition next to mid-flight helper) so reconcile and tests share one definition.
- Tests: `core/test/loop-reconcile.test.ts` and `core/test/loop-supervisor.test.ts` with injected observe/store/dispatch seams only.
- Required regressions:
  1. `pr_opened` + stage `ready` + open PR + !R2D + checks success → heal → supervisor `dispatchItem` called (`dispatched >= 1`).
  2. Fixture where without fix consecutive no-progress would stop with `supervisor_no_progress` while `next_actions` is `advance` — must not stop that way with the fix.
  3. Preserve mid-flight heal, R2D → `ready`, merged → `merged`, needs-human not healed.
- After `core/` edits: `node scripts/build.mjs` and commit `plugin/` in the same change set; `npm run ci`.

## Risks / Trade-offs

- **[Risk] Heal re-dispatches work that should wait on CI** → Mitigation: advance already handles pending checks; optional leave `await-checks` items undpatched only if next action is not `advance` — heal still allowed; supervisor re-entry is OK. Do not require checks success for heal (matches mid-flight heal).
- **[Risk] Two-cycle lag (catch-up to pr_opened then heal)** → Mitigation: Decision 4 no-progress guard; prefer same-pass post-mutation heal when cheap.
- **[Risk] Oscillation heal ↔ catch-up** → Mitigation: heal only from `pr_opened`; mid-flight gate prevents re-promotion for mid-flight; for intake-ready, catch-up only from **local** states, not from `in_progress` after heal (aligned open PR + pr_opened classification stays aligned; once healed to `in_progress`, local + open PR + ready may re-classify as ledger-behind to pr_opened under #511 — **must not** reintroduce stranding). **Critical implementer note:** after heal, `in_progress` + open PR + stage `ready` currently #511-repairs back to `pr_opened` (non-mid-flight). That would oscillate. **Required companion:** for local `in_progress` that was advance-still-needed (open PR + !R2D + stage not needs-human), do **not** repair-forward to stranded `pr_opened` solely for open PR — either (a) treat “advance still needed” like mid-flight for the local→pr_opened gate (recommended class generalization), or (b) same-pass always heal so net effect stays dispatchable and tests assert no oscillation across two reconciles. Prefer (a): generalize the local→`pr_opened` gate from “mid-flight only” to “open PR does not prove terminal catch-up while advance still needed (not R2D / not merged / not needs-human terminal hold)”. That supersedes #511 only for the residual that is still advance-eligible; crash-after-PR-open with **no** further work needed is not this case — open PR without R2D always still needs advance toward R2D under grill-lock.
- **[Risk] needs-human re-dispatch** → Mitigation: explicit exclusion on stage `needs-human` and existing blocked/hold paths.
- **[Risk] Scope creep into scheduler redesign** → Mitigation: Decision 1 — no frontier change for `pr_opened`.

## Migration Plan

1. Implement reconcile gate/heal generalization + supervisor no-progress guard + tests in `core/`.
2. Regenerate `plugin/` via `node scripts/build.mjs` in the same commit(s) as `core/` edits.
3. In-flight runs: next reconcile heals stranded intake-ready `pr_opened` items and re-dispatches advance toward R2D.
4. Rollback: revert the change; prior stranding returns (no data migration).

## Open Questions

- _(Resolved)_ Shape = advance-still-needed heal + no-progress guard; not a general advance dispatcher.
- _(Resolved)_ Companion gate on local→`pr_opened` for advance-still-needed to prevent heal oscillation (Decision 5 risk note).
- _(Resolved)_ Grill-lock: `pipeline:ready` is intake-ready; not R2D + open PR + `pr_opened` is advance-eligible.
