## Context

See `proposal.md` for motivation and dogfood evidence (#599 / PR #1058).

**Current state (relevant seams):**

- `DEFAULT_RECOVERY_POLICY["review-findings"]` is only `["repair_pipeline_item"]` with `retry_budget: 3` (`core/scripts/loop/recovery.ts`).
- `DEFAULT_RECOVERY_POLICY["workflow-engine-defect"]` already starts with `unlink_engine_scratch` (#1020 / #1028).
- Supervisor recipe selection is round-robin over the class recipe list: `recipes[matchingAttempts.length % recipes.length]` (`loop/supervisor.ts` `executeBlockedRecovery`).
- `startRecoveryAttempt` decrements `recovery_budgets_remaining` when an attempt starts (`recovery.ts`) — every claimed action costs a budget unit today.
- `unlink_engine_scratch` (`pipeline.ts`) succeeds only for **scratch-only** porcelain: unlinks engine-known scratch, clears `pipeline:blocked` when present, does not open a harness round. No-scratch or product-dirt cases fail with “trying next recipe”.
- `repair_pipeline_item` collapses every non-`fix-committed` result except `noop-clean` into one generic string (`repair-pipeline-item.ts` ~478–483). Pre-merge autofix already has richer statuses (`fix-committed` | `noop-clean` | `error` | …) with optional `diagnostic`. Pre-dirty refusal often returns bare `{ status: "error" }` with no diagnostic (`pre-merge-autofix.ts` ~590–591).
- Shared porcelain classifier: `classifyPorcelainForScratchRecover` / `worktree-dirt.ts` (engine-known set includes `artifacts/challenge-response-*.json`; rest of `artifacts/**` remains product dirt).

**Class vs site (engine-dogfood bar):**

- Class: recovery for genuine `review-findings` must prep engine scratch deterministically and emit typed repair-failure evidence.
- Shared surfaces: default recovery policy, class-scoped unlink semantics, repair-shell failure evidence. Not a path-local mole in one supervisor branch.

## Goals / Non-Goals

**Goals:**

- Preparatory unlink before implementer repair for the `review-findings` class when engine-known scratch is present.
- Prep unlink (success or no-scratch not-applicable) advances to `repair_pipeline_item` in the **same recovery sequence** without marking findings recovered and without consuming findings retry / repeated-evidence budget.
- Repair never treats engine-known challenge-response scratch as product dirt that blocks or masks a real fix commit **because prep already cleared it**.
- Debuggable non-success from `repair_pipeline_item` (typed category + status + diagnostic/harness tail) that survives into the recovery result and `loop_recovery_action_executed` event.
- Stale **exact** default policy migration for long-lived runs still on repair-only recipes; custom policies preserved.
- Keep review gates and substantive candidate movement requirements intact.

**Non-Goals:**

- Fixing the product findings from #599 themselves (identity encoding / analysis persistence) — those are product work on that ship PR.
- Reclassifying true human-authority holds, or demoting review findings to scratch.
- Changing `workflow-engine-defect` order or scratch-only full recover (already specified).
- Broad `artifacts/**` waiver; auto-merge; LLM-as-first-recoverer; second recoverer inside `train.ts`.
- Expanding repair authority or bypassing review/CI re-entry after a successful push.
- Dual/redundant scratch cleanup inside `repair_pipeline_item` (single authoritative boundary — D3).

## Decisions

### D1: Default `review-findings` recipes = unlink then repair

**Decision:** Set

```text
DEFAULT_RECOVERY_POLICY["review-findings"].recipes =
  ["unlink_engine_scratch", "repair_pipeline_item"]
```

Keep existing budgets (`retry_budget: 3`, `repeated_evidence_limit: 2`). Budget accounting for prep is defined in D3 — do not raise budget to paper over rotation.

**Rationale:** Matches issue acceptance and class-over-site: the same deterministic unlink action used for `workflow-engine-defect` becomes the first recipe for findings recovery. Policy order is unit-testable without network.

**Alternatives:**

- Unlink only inside `repair_pipeline_item` (no policy change) — fixes dirt but does not satisfy the recipe-list acceptance or shared policy law.
- New recipe id `prep_unlink_engine_scratch` — unnecessary catalogue growth; reuse the existing action id with class-scoped semantics (D2).

### D2: Unlink under `review-findings` is preparatory, never terminal recover

**Decision:** When the claimed action is `unlink_engine_scratch` and the durable class is `review-findings`:

1. **Scratch present (product dirt empty under shared classifier):** unlink only those engine-known scratch paths. **Do not** return `succeeded: true`. **Do not** clear `pipeline:blocked`. **Do not** invoke sibling live-filer as if findings recovered. Return a **prep-complete fall-through** failure whose evidence states scratch was unlinked and the next recipe must repair.
2. **No engine-scratch paths:** fail closed with not-applicable / trying next recipe (existing no-scratch string family) so repair remains reachable.
3. **Product dirt present:** fail closed (no unlink of product paths, no false clear). Residual product dirt still blocks safe repair later.

When class is `workflow-engine-defect` (or other scratch-only recover path), keep today’s terminal success: unlink + clear blocked when scratch-only, no harness round, sibling filer on recover.

**Rationale:** #599 porcelain was scratch-only while the **blocker class** was still real findings. Terminal unlink success would clear blocked without candidate movement — violates “findings fixed only by substantive repair”.

### D3: Same-sequence prep; free of findings repair budget; single cleanup boundary

**Decision (authoritative — resolves dual-prep ambiguity):**

1. **Same recovery sequence:** After a `review-findings` `unlink_engine_scratch` claim finishes (prep-complete **or** no-scratch not-applicable), the supervisor **continues in the same `executeBlockedRecovery` cycle** and claims/executes `repair_pipeline_item` next (when a candidate head exists and class budget remains). Do not wait for a later idle cycle solely to rotate recipes after a prep fall-through.
2. **Budget / repeated-evidence:** Starting or completing preparatory `unlink_engine_scratch` for class `review-findings` **SHALL NOT** decrement `recovery_budgets_remaining["review-findings"]` and **SHALL NOT** increment `repeated_evidence_count` as if a repair attempt failed. Prep claims may still be ledgered for audit (`loop_recovery_attempt_*` / evidence strings). Only `repair_pipeline_item` (and any future substantive findings recipes) charge the class retry budget.
3. **Recipe selection after prep:** Prefer selecting `repair_pipeline_item` immediately after a findings prep unlink result in the same sequence (not modulo rotation that re-picks unlink while scratch is already gone). When no engine-known scratch is present at claim time, skip claiming unlink and claim `repair_pipeline_item` directly (still unit-tested that default recipe **order** lists unlink first).
4. **Single authoritative scratch-cleanup boundary:** Engine-known scratch is removed **only** by the `unlink_engine_scratch` recovery action. **`repair_pipeline_item` does not** best-effort strip engine scratch before invoke. If residual porcelain includes engine-known scratch after prep should have run, repair fails closed as **dirt-blocked** with classification evidence (operator signal that prep did not run or failed) — never silent strip, never broad `artifacts/**` waiver.

**Rationale:** Round-robin `matchingAttempts % n` with a budgeted unlink would burn ~half the findings budget on prep no-ops (#599 budget 3 → at most one or two real repairs). Same-sequence free prep preserves the three repair attempts for implementer work. One boundary prevents divergent cleanup and diagnostic erasure between callers.

**Alternatives rejected:**

- Optional dual-prep inside repair “if design chooses” — **rejected** (reviewer: choose one boundary).
- Raise `retry_budget` only — papers over rotation waste.
- Terminal success + re-enter — false recover for findings class.

### D4: Typed, bounded repair failure evidence (stable contract)

**Decision:** When `repair_pipeline_item` does not return `fix-committed`, build a single operator-visible evidence/error string (and optional structured fields if already cheap on `RepairPipelineItemResult`) that always includes:

| Field | Required | Values / rules |
| --- | --- | --- |
| `status` | yes | Non-success status id from autofix/shell (`noop-clean`, `error`, dirt-blocked shell refusal, claim-failed, etc.) |
| `category` | yes | Closed set: `noop-clean` \| `dirt-blocked` \| `harness-error` \| `no-diagnostic` |
| `diagnostic_tail` | when captured | Bounded tail (e.g. last N chars, reuse existing harness redaction/truncation). When absent, evidence **explicitly** says no diagnostic was captured |

**Category mapping (fail-closed, no mislabel):**

| Source outcome | Category |
| --- | --- |
| Implementer/shared round `noop-clean` | `noop-clean` — include implementer diagnostic when present |
| Pre-invoke or commit refuse because residual porcelain / dirty tree (including engine-scratch residual or product dirt) | `dirt-blocked` — path summary via **shared** `classifyPorcelainForScratchRecover` (or equivalent shared path split); product vs engine-scratch labels; **no** broad `artifacts/**` waive; product dirt remains blocked |
| Harness/executor `error`, crash, non-commit after invoke, push failure, etc. with any captured diagnostic/stdout | `harness-error` — status + bounded tail |
| Non-success with no captured diagnostic | `no-diagnostic` — status + explicit “no diagnostic captured” |

**Must not mislabel:** committed-but-unpushed salvage/reconcile failures, harness crash, and bare pre-dirty `error` **must not** become `noop-clean`.

**Survival path:** The same evidence/error string is returned as `RepairPipelineItemResult.{evidence,error}` and is what the supervisor writes into `loop_recovery_action_executed` (`evidence` / `error` fields) and `completeRecoveryAttempt` error — i.e. what the dashboard/ledger already consume. Do not invent a parallel dashboard channel in this change.

Keep the generic phrase “did not produce a committed and pushed repair” only as a **suffix or fallback label**, never as the sole content when status/category/diagnostic exist.

**Dirt-blocked classifier rule:** Use the shared porcelain classifier only (`worktree-dirt.ts` / `classifyPorcelainForScratchRecover`). Target recognized engine-scratch paths for *classification labels* in evidence; never delete product dirt; never expand non-product globs to all of `artifacts/**`.

### D5: Stale default migration (precise)

**Decision:** Add **exactly one** stale entry for `review-findings` to `STALE_DEFAULT_POLICY_ENTRIES`:

```text
{
  recipes: ["repair_pipeline_item"],
  retry_budget: 3,
  backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
  terminal_outcome: "retry",
  run_fatal: false,
  repeated_evidence_limit: 2,
}
```

`upgradeContractForRecovery` already migrates only when `samePolicyEntry` matches an exact stale default and leaves non-matching (user-custom) entries untouched — preserve that behavior. **Tests required:**

1. Exact pre-#1060 repair-only default → new default recipes (`unlink` then `repair`).
2. Custom policy that still lists only `repair_pipeline_item` but differs in budget/backoff/limit/order → **unchanged**.
3. Unrelated class custom entries → unchanged.

### D6: Spec surface

**Decision:**

- **MODIFIED** `autonomous-recovery-controller`: review recovery recipe list + preparatory semantics + same-sequence free prep; ADDED typed failure-evidence requirement for `repair_pipeline_item`.
- **ADDED** under `engine-scratch-recover`: preparatory unlink for `review-findings`; terminal `workflow-engine-defect` path unchanged.

No new capability id.

## Risks / Trade-offs

- **[Risk] Budget-exempt prep is a special case** → Mitigation: scope exemption strictly to `(class=review-findings, action=unlink_engine_scratch)`; unit-test that repair still charges; workflow-engine-defect unlink still charges/normal path as today (its success is terminal).
- **[Risk] Same-sequence multi-claim complicates supervisor** → Mitigation: localize to findings prep fall-through continuation after complete; regression for #599 shape + no-scratch skip-to-repair.
- **[Risk] Changing unlink success semantics by class confuses executor** → Mitigation: branch only on `input.blockerClass`; unit-test both terminal and prep fall-through; do not change scratch-only composition coverage for engine-defect.
- **[Risk] Harness log tails leak secrets** → Mitigation: reuse existing harness log redaction/truncation; bound tail length.
- **[Risk] Over-clearing blocked after prep unlink** → Mitigation: D2 forbids clear-on-prep for findings class; scenario test.

## Migration Plan

1. Land policy + class-scoped unlink prep + same-sequence budget-free prep + repair evidence in one PR with tests.
2. Regenerate `plugin/` with `node scripts/build.mjs` in the same commit as any `core/` edit.
3. Existing durable runs: `upgradeContractForRecovery` migrates **exact** stale defaults on next recovery entry; no manual ledger rewrite; customs preserved.
4. Rollback: revert the change; pre-migration contracts remain valid under compileRecoveryPolicy.

## Open Questions

None that block implementation. Exact tail length constant and evidence string templates are implementer choices as long as categories, survival path, and scenarios remain falsifiable.
