## Why

Human-gated merge-queue drive walks ready-to-deploy PRs through the existing
`pipeline merge` / `mergePr` surface. When a candidate is non-mergeable (merge
conflicts) or has red required checks after restack, the queue must not
force-merge or abandon the whole batch without evidence. Operators need a
**bounded, surgical repair hold**: pause that item with a clear reason,
optionally apply a minimal conflict/CI-only fix in the managed worktree, re-run
the same eligibility gates, then retry merge — without inventing a second merge
path, a merge-queue-only recovery taxonomy, or silent `auto_merge`.

## What Changes

- Define **typed hold reasons** for merge-queue items: at least `merge-conflict`
  and `checks-failed`, each with operator-visible remediation text.
- On conflict or red required checks during drive, the queue **records a hold**
  and **never** force-merges. Default policy is **hold the item and continue**
  with remaining candidates (matches the shipped drive failure isolation and
  release-when-complete completeness model).
- Optional **repair path** (explicit flag and/or config, default off): open or
  rematerialize the PR’s managed worktree and attempt remediation under
  **surgical-fix** discipline (minimal conflict/CI-only diff — no broad feature
  work).
- Repair reuses the **shipped deterministic-first recovery contract** (#787):
  attempt clean rebase / check remediation before model implementer repair
  (`repair_pipeline_item` or the shared mechanical-remediation transaction),
  claim before side effects, and charge a bounded budget. Do **not** invent a
  merge-queue-only recovery taxonomy or provider-specific model path.
- After any candidate-changing repair push, the queue **re-runs the same
  eligibility gates** (open, R2D/policy, mergeable/CLEAN, required checks green)
  before retrying merge through the existing merge surface only.
- Repair is **budget-bounded** (max attempts and/or max wall-clock). Exhaustion
  leaves a typed stopped / manual-repair outcome with evidence. That outcome is
  a queue hold for completeness reporting; it becomes a **human-authority** hold
  only when a current, attested product or authority decision is actually
  required (same predicate as autonomous recovery — mechanical exhaustion alone
  is not human authority).
- Unit tests cover: conflict → hold (no merge); successful repair → re-eligible
  → merge may proceed; budget exhaust → held with evidence; no merge while
  required checks are red.
- **No** `auto_merge` config key; advance loop remains merge-free; held items
  never merge without re-gate success.

## Acceptance Criteria

- [ ] Hold reason vocabulary includes at least `merge-conflict` and
      `checks-failed`, each with operator-visible remediation text naming the PR
      (and linked issue when known) and concrete next steps.
- [ ] On conflict or red required checks during apply/drive, the queue records a
      hold and **does not** force-merge that PR.
- [ ] Default stop/continue policy is **hold the item and continue** remaining
      candidates in the same drive (held items remain visible for
      release-when-complete completeness).
- [ ] Without the optional repair flag/config, a conflict/red-check item is held
      with evidence and no implementer repair side effects run.
- [ ] With repair enabled and budget remaining, the path attempts deterministic
      remediation first, then bounded surgical/mechanical repair in the managed
      worktree only — no feature expansion under the guise of conflict/CI fix.
- [ ] After a repair that changes the candidate head, the queue re-runs the same
      eligibility gates before any merge retry; merge occurs only via the
      existing `mergePr` / `pipeline merge` surface.
- [ ] Repair budget exhaustion leaves the item held (or typed stopped /
      manual-repair) with evidence; it does **not** auto-merge and does **not**
      invent a separate merge-queue recovery taxonomy.
- [ ] Mechanical budget exhaustion alone does **not** create a human-authority /
      `human_intervention` hold unless current attested product/authority
      evidence is present.
- [ ] Unit tests with injected deps prove: conflict → hold; successful repair →
      re-eligible; budget exhaust → hold; no merge on red checks; no real
      network/git/subprocess in unit tests.
- [ ] `npm run ci` green; regenerate `plugin/` if `core/` changes.

## Capabilities

### New Capabilities

- `merge-queue-repair-hold`: Typed hold reasons, hold-and-continue isolation,
  optional surgical/mechanical repair with deterministic-first ladder, bounded
  budget, re-gate before merge retry, and operator-visible remediation evidence
  for conflict/CI failures on the human-gated merge-queue drive.

### Modified Capabilities

- `merge-queue-command`: Extend the human-gated merge-queue surface so apply/
  drive may record typed holds and optionally accept a repair opt-in without
  introducing `auto_merge` or advance-loop merge authority.
- `merge-queue-release-when-complete`: Align held-item completeness with the
  typed hold reasons (`merge-conflict`, `checks-failed`, repair-budget
  exhaustion outcomes) so incomplete queues still block release prepare.

## Impact

- **CLI / drive:** `pipeline merge-queue --apply` path under
  `core/scripts/stages/merge-queue.ts` (and related selection modules under
  `merge_queue.ts`); optional `--repair` (or equivalent) + config defaults.
- **Reuse (do not fork):** `mergePr` / `MergeDeps`, pre-merge CI poll helpers
  where applicable, managed worktree resolution/rematerialization, surgical-fix
  prompt discipline, and the #787 recovery claim/budget/`repair_pipeline_item`
  (or shared mechanical-remediation) contract.
- **Tests:** hermetic unit tests via deps seams for hold classification, budget,
  re-gate, and no-merge-on-red invariants.
- **Out of scope:** broad feature work as “conflict fix”; auto-merge of held
  items without re-gate; multi-repo release trains; advancing merge authority
  into the autonomous loop.
