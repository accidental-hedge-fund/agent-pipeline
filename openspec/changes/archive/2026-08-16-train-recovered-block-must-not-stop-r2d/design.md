## Context

See `proposal.md` for motivation.

Production train advances a base-eligible frontier via one multi-item loop wave, then classifies each item from live labels plus extracted loop evidence. Today `extractTrainAdvanceLoopEvidence` keeps the last `loop_item_blocked` for the wave. `classifyTrainAdvanceLabels` treats any structured block evidence as `advanceFailed`, including when the live label is already `pipeline:ready-to-deploy`. That was #1074 (“do not mask a failed wave with a success label”). It is too coarse: a **recovered** mid-run class is treated as the wave still failed.

Merge-mode train STOPs on `!advanced.ok` before the merge wave. A recovered R2D item therefore never reaches the existing merge surface.

`transitionItem` copies the whole ledger item and only overwrites `state` and `history`. A later `ready` transition therefore leaves `blocked_theme` set. Recovery to `in_progress` **retains** theme on purpose (class identity for the resume). Ready is a successful terminal; leftover theme is stale.

Constraints:

- Class over site: fix the shared classifier / evidence extractor / ready-transition writer. Do not add a #1037-only mole.
- #1074 remains: a wave that actually stopped or left a non-zero engine failure MUST NOT classify as success just because an earlier label flicker said R2D.
- Production path stays multi-item loop advance wave. Advance / loop never merge.
- Unit tests inject deps. No real network, git, or subprocess.

## Goals / Non-Goals

**Goals:**

- Last **terminal** event for an item wins. A later successful terminal supersedes an earlier `loop_item_blocked` for that item.
- Live R2D + recovered successful wave → classify ok; merge-mode merges.
- Ledger `ready` does not keep a current `blocked_theme`.
- Preserve #1074 for real stop / engine failure.

**Non-Goals:**

- Changing when the loop emits `loop_item_blocked` or how recovery recipes run.
- Clearing `blocked_theme` on resume to `in_progress` (existing recovery identity).
- Weakening a still-current test-gate failure.
- Changing FRG / `--skip-frg`.
- Merging PR #1094 as part of this change.

## Decisions

### D1 — Last terminal wins in the shared evidence extractor

**Decision:** The shared train advance-wave evidence extractor SHALL treat later successful terminals as clearing earlier item-block fields for that item. Successful terminals include item `ready_to_deploy` / ledger `ready` and wave `all_done` / `loop_run_complete` without a later `loop_run_stopped`. A later `loop_run_stopped` remains current stop evidence.

**Rationale:** The #1037 ship had both `loop_item_blocked` (`implementation-ci`) and a later `ready_to_deploy` / `all_done` in the same run. Last-field-wins for `loop_item_blocked` only is the defect. Last-terminal-wins is the class rule.

**Alternatives considered:**

- Classifier-only ignore leftover `blockedClass` when labels are R2D → rejected as sole fix. Evidence would still report a current block; other consumers of the extractor could reintroduce the STOP.
- Site-local train.ts string match for `implementation-ci` + R2D → rejected (mole; next recovered class would need another issue).

### D2 — Classifier treats only current failure evidence as `advanceFailed` on R2D

**Decision:** When live labels are `pipeline:ready-to-deploy` and there is no live `blocked` label, structured **item-block** evidence SHALL NOT by itself make the outcome non-ok. Current `loop_run_stopped`, non-zero engine exit, or engine failure message SHALL still make the outcome non-ok (#1074).

**Rationale:** #1074 forbids masking a failed wave with a success label. It does not require treating a recovered, superseded block as a failed wave. Live `blocked` label remains a park, not a merge candidate.

**Alternatives considered:**

- Revert the entire R2D+evidence → fail rule from #1074 → rejected. That would re-mask a wave that stopped after a label flicker.
- Require both extractor clear **and** live R2D before ok, and still fail if `blockedClass` remains → belt-and-suspenders with D1; keep both so a missed extract path still cannot STOP merge of a live R2D item unless a real stop/engine failure is current.

### D3 — Merge-mode is a consequence, not a second merge path

**Decision:** Do not add a train-local merge recoverer. Once classify returns ok + terminal `ready-to-deploy`, existing merge-mode law (`!advanced.ok` STOP, then serial merge wave) already merges. Prove this with a train fixture that injects the recovered-block-then-R2D wave and asserts the merge surface is invoked.

**Rationale:** Smallest coherent diff. Advance/loop still never merge.

**Alternatives considered:**

- Special-case merge-mode to ignore `advanced.ok` when labels are R2D → rejected. That would also ignore real #1074 failures.

### D4 — Clear current `blocked_theme` only on transition to `ready`

**Decision:** The ready-transition writer SHALL omit or unset current `blocked_theme` when `to === "ready"`. History entries that recorded the prior block stay. Resume to `in_progress` after recovery SHALL continue to retain theme (existing contract).

**Rationale:** Type comment already says `blocked_theme` is the current class when `state === "blocked"`. Leftover theme on `ready` is what the #1037 ledger showed. Clearing at the source prevents any later consumer (train, FRG, improve) from treating a ready item as still blocked.

**Alternatives considered:**

- Ignore leftover theme only in train classify → rejected as sole fix (class leak remains in the ledger).
- Also clear `evidence_fingerprint` / budgets → out of scope. Fingerprint is last-block history; budgets are remaining class budget. Only current theme is stale on `ready`.

### D5 — Shared surfaces, not a train.ts mole

**Decision:** Implement in the shared evidence extractor, the shared label classifier, and the shared ready-transition writer. Production train and any adapter that uses those helpers inherit the class. Do not add a Tugboat or path-local rewrite.

**Rationale:** Engine-dogfood bar: the next identical recovered-block-then-R2D fault must not need a new issue.

## Risks / Trade-offs

- **[Risk] Over-clearing a still-current block when a later sibling is `all_done`** → **Mitigation:** Scope successful-terminal clear to the **same item**. Wave `all_done` may clear item-block fields only for items that themselves reached ready / R2D. A sibling that is still blocked keeps its `blockedClass`.
- **[Risk] Label flicker R2D + recovered extract looks ok while the wave actually stopped** → **Mitigation:** D2 keeps `loop_run_stopped` / engine failure as current failure even when labels are R2D (#1074 fixtures stay red if that regresses).
- **[Risk] Clearing `blocked_theme` on ready breaks a reader that keys recovery off leftover theme** → **Mitigation:** Recovery already requires `state === "blocked"`. Ready items are not recovery candidates. Keep resume-to-`in_progress` theme retention.
- **[Risk] Event vocabulary for “successful terminal” is incomplete** → **Mitigation:** Spec the observable set (`ready_to_deploy`, ledger `ready`, `all_done` / `loop_run_complete` without later `loop_run_stopped`). Implementer maps those onto existing event kinds; tests use injected events.

## Migration Plan

- Land as ordinary PR under #1095. No config flag.
- After promote, the next `--merge` train that recovers a mid-run `implementation-ci` (or any recoverable class) then reaches live R2D merges instead of STOP.
- Rollback: revert the extractor / classifier / ready-transition changes; leftover-block STOP returns.

## Open Questions

None that block specs or tasks. Exact helper field names stay an implement detail as long as last-terminal-wins and #1074 hold.
