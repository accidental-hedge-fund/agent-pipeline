## Context

See `proposal.md` for motivation and dogfood evidence (#599 / PR #1058).

**Current state (relevant seams):**

- `DEFAULT_RECOVERY_POLICY["review-findings"]` is only `["repair_pipeline_item"]` with `retry_budget: 3` (`core/scripts/loop/recovery.ts`).
- `DEFAULT_RECOVERY_POLICY["workflow-engine-defect"]` already starts with `unlink_engine_scratch` (#1020 / #1028).
- Supervisor recipe selection is round-robin over the class recipe list: `recipes[matchingAttempts.length % recipes.length]` (`loop/supervisor.ts`).
- `unlink_engine_scratch` (`pipeline.ts`) succeeds only for **scratch-only** porcelain: unlinks engine-known scratch, clears `pipeline:blocked` when present, does not open a harness round. No-scratch or product-dirt cases fail with “trying next recipe”.
- `repair_pipeline_item` collapses every non-`fix-committed` result except `noop-clean` into one generic string (`repair-pipeline-item.ts` ~478–483). Pre-merge autofix already has richer statuses (`fix-committed` | `noop-clean` | `error` | …) with optional `diagnostic`.

**Class vs site (engine-dogfood bar):**

- Class: recovery for genuine `review-findings` must prep engine scratch deterministically and emit typed repair-failure evidence.
- Shared surfaces: default recovery policy, `unlink_engine_scratch` semantics when claimed under findings class, repair-shell failure evidence. Not a path-local mole in one supervisor branch.

## Goals / Non-Goals

**Goals:**

- Preparatory unlink before implementer repair for the `review-findings` class when engine-known scratch is present.
- Repair never treats engine-known challenge-response scratch as product dirt that blocks or masks a real fix commit.
- Debuggable non-success from `repair_pipeline_item` (status + diagnostic/harness tail).
- Stale default policy migration for long-lived runs still on repair-only recipes.
- Keep review gates and substantive candidate movement requirements intact.

**Non-Goals:**

- Fixing the product findings from #599 themselves (identity encoding / analysis persistence) — those are product work on that ship PR.
- Reclassifying true human-authority holds, or demoting review findings to scratch.
- Changing `workflow-engine-defect` order or scratch-only full recover (already specified).
- Broad `artifacts/**` waiver; auto-merge; LLM-as-first-recoverer; second recoverer inside `train.ts`.
- Expanding repair authority or bypassing review/CI re-entry after a successful push.

## Decisions

### D1: Default `review-findings` recipes = unlink then repair

**Decision:** Set

```text
DEFAULT_RECOVERY_POLICY["review-findings"].recipes =
  ["unlink_engine_scratch", "repair_pipeline_item"]
```

Keep existing budgets (`retry_budget: 3`, `repeated_evidence_limit: 2`) unless tests prove rotation starves repair (see D3).

**Rationale:** Matches issue acceptance and class-over-site: the same deterministic unlink action used for `workflow-engine-defect` becomes the first recipe for findings recovery. Policy order is unit-testable without network.

**Alternatives:**

- Unlink only inside `repair_pipeline_item` (no policy change) — fixes dirt but does not satisfy the recipe-list acceptance or shared policy law.
- New recipe id `prep_unlink_engine_scratch` — unnecessary catalogue growth; reuse the existing action id.

### D2: Unlink under `review-findings` is preparatory, not terminal recover

**Decision:** When the claimed action is `unlink_engine_scratch` and the durable class is `review-findings`:

1. If engine-known scratch paths are present (product dirt empty under the shared classifier): unlink those paths only. **Do not** treat the attempt as successful whole-item recovery for findings. **Do not** clear `pipeline:blocked` solely because scratch was removed while findings remain the active recovery class. Return a **non-success fall-through** outcome whose evidence states scratch was unlinked and next recipe must repair (same “trying next recipe” spirit as product-dirt fall-through today).
2. If no engine-scratch paths: fail closed with “not applicable / trying next recipe” (existing no-scratch path) so repair is selected on the next claim.
3. Product dirt still fail-closed (no false clear, no implementer pretend-success).

When class is `workflow-engine-defect` (or other scratch-only recover path), keep today’s terminal success: unlink + clear blocked when scratch-only, no harness round.

**Rationale:** #599 porcelain was scratch-only while the **blocker class** was still real findings. Terminal unlink success would clear blocked, re-enter, re-block — workable but spends a budget unit and can race train/status. Explicit prep fall-through keeps “findings fixed only by candidate movement” (existing requirement) and still guarantees a clean tree before the next repair claim. Scratch-only `workflow-engine-defect` behavior must not regress.

**Alternatives:**

- Terminal success + re-enter (rely on re-block) — simpler code reuse, wastes a cycle and can look like false recover in events.
- Always terminal success for any class — **rejected**: clears findings blocks without a push.

### D3: Avoid starving repair under recipe rotation

**Decision:** Because supervisor selects `recipes[attemptCount % n]`, a two-recipe list with repeated unlink no-ops would alternate unlink/repair and burn budget. Mitigation (implement one or both; prefer both if cheap):

1. **Policy-level:** Keep two recipes; ensure unlink no-scratch / prep-complete outcomes complete quickly with clear evidence so operators see progression (already fail-forward).
2. **Selection-level (preferred if rotation starves):** When selecting the next recipe for `review-findings`, skip `unlink_engine_scratch` when current porcelain has **no** engine-known scratch (still pure/injectable classification in the recovery preflight or executor preflight). Always run unlink when scratch is present before any further repair claim for that fingerprint.
3. **Defense in depth:** `repair_pipeline_item` best-effort unlinks engine-known scratch **before** pre-dirty refusal / implementer invoke, using the shared classifier — so even a lone repair claim never fails solely on challenge-response porcelain.

Acceptance requires unlink-before-repair when scratch is present; it does not require every budget unit to attempt unlink when scratch is absent.

**Rationale:** Class fix without turning a clean tree into a 50% wasted-attempt tax.

**Alternatives:** Raise `retry_budget` only — paper over rotation waste.

### D4: Typed repair failure evidence

**Decision:** When `repair_pipeline_item` does not return `fix-committed`, the recovery result `error` / `evidence` string MUST include:

| Outcome | Minimum content |
| --- | --- |
| `noop-clean` | Existing explicit “inspected but produced no verifiable candidate change” + implementer diagnostic |
| Dirt / porcelain blocked commit or pre-dirty refusal involving residual paths | Status + path summary (classify engine scratch vs product dirt) + note that engine scratch should have been unlinked before repair |
| `error` / harness failure / other non-commit | Status id + truncated harness stdout/stderr or shared-round diagnostic tail (bounded length, e.g. last N chars) |
| Unknown / missing diagnostic | Status id + explicit “no diagnostic captured” rather than the sole generic collapsed string |

Keep the generic phrase only as a **suffix or fallback label**, never as the only content when a status or diagnostic exists.

**Rationale:** Issue B: supervisor and operators cannot choose `restart_workflow_engine`, re-file, or re-prompt without knowing whether the implementer ran, declined, or was blocked by dirt.

**Alternatives:** Structured JSON evidence field only — good long-term; string evidence is what the loop ledger and dashboard already surface today; prefer enriching the string first, optional structured fields if a seam already exists.

### D5: Stale default migration

**Decision:** Add the pre-#1060 default entry

```text
recipes: ["repair_pipeline_item"], retry_budget: 3, … (exact current default fields)
```

to `STALE_DEFAULT_POLICY_ENTRIES["review-findings"]` so `upgradeContractForRecovery` rewrites exact stale defaults to the new recipes list. Custom non-default policies stay untouched.

**Rationale:** Same pattern as #758 / #1020 policy migrations; durable runs must not keep repair-only forever after upgrade.

### D6: Spec surface

**Decision:**

- **MODIFIED** `autonomous-recovery-controller`: “Review recovery SHALL perform substantive repair before redispatch” — recipe list includes preparatory unlink; success still requires candidate movement; ADDED failure-evidence requirement for `repair_pipeline_item`.
- **MODIFIED** / **ADDED** under `engine-scratch-recover`: preparatory unlink for `review-findings` when scratch present; does not reclassify findings as scratch-only terminal recover.

No new capability id.

## Risks / Trade-offs

- **[Risk] Recipe rotation burns repair budget on unlink no-ops** → Mitigation: D3 skip-when-no-scratch and/or in-repair prep unlink; tests for no-scratch still reaching repair within budget.
- **[Risk] Changing unlink success semantics by class confuses executor** → Mitigation: branch only on durable class / diagnostic projection; unit-test both `workflow-engine-defect` terminal and `review-findings` prep fall-through; do not change scratch-only composition coverage for engine-defect.
- **[Risk] Harness log tails leak secrets** → Mitigation: reuse existing harness log redaction/truncation; bound tail length; no new credential logging.
- **[Risk] Over-clearing blocked after prep unlink** → Mitigation: D2 forbids clear-on-prep for findings class; scenario test.

## Migration Plan

1. Land policy + unlink prep semantics + repair evidence in one PR with tests.
2. Regenerate `plugin/` with `node scripts/build.mjs` in the same commit as any `core/` edit.
3. Existing durable runs: `upgradeContractForRecovery` migrates exact stale defaults on next recovery entry; no manual ledger rewrite.
4. Rollback: revert the change; pre-migration contracts remain valid under compileRecoveryPolicy.

## Open Questions

None that block implementation. Tail length and exact error string templates can be chosen in implementation as long as scenarios remain falsifiable.
