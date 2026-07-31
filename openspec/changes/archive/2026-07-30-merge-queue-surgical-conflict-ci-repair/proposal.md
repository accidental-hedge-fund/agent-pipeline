## Why

The human-gated merge-queue drive (#674) walks ready-to-deploy PRs through the existing
`/pipeline:merge` surface. When a candidate is non-mergeable (merge conflicts) or has red
required checks after restack, today's options collapse to abandon the batch or force past
gates. Operators need a **bounded, surgical repair hold**: pause that queue item with a clear
reason, optionally apply a minimal conflict/CI-only fix in the managed worktree, re-validate
eligibility, then retry merge — without inventing a second merge path or silent `auto_merge`.

## What Changes

- Define **hold reasons** for merge-queue items: at least `merge-conflict` and
  `checks-failed`, each with operator-visible remediation text.
- On conflict or red required checks during drive, the queue **records a hold** and **never**
  force-merges; default policy is **hold the item and continue** with remaining candidates
  (aligned with drive stop/continue and the loop hold-continuation pattern).
- Optional **repair path** (config or explicit flag): open/use the PR's managed worktree and
  invoke a fix/implementer under **surgical-fix** discipline (minimal diff for conflict or
  CI failure only — no broad feature work).
- After a repair push, the queue **re-runs the same eligibility gates** (open, R2D/policy,
  mergeable, required checks green) before retrying merge through the existing merge surface
  (`mergePr` / `pipeline merge` path).
- Repair is **budget-bounded** (max attempts and/or max wall-clock); exhaustion leaves the
  item held for a human with evidence (hold reason, attempts, check/conflict summary).
- Unit tests cover: conflict → hold; successful repair → re-eligible; budget exhaust → hold;
  no merge while required checks are red.
- **No** `auto_merge` config key; advance loop remains merge-free; held items never merge
  without re-gate success.

## Acceptance criteria

- [ ] Hold reason vocabulary includes at least `merge-conflict` and `checks-failed`, each
      with operator-visible remediation text naming the PR and next human or repair steps.
- [ ] When drive observes merge conflicts or red required checks, the item is held (not
      force-merged); the drive either continues remaining candidates or stops per the
      documented default (hold-and-continue), and never calls the merge surface for that item
      while ineligible.
- [ ] Optional repair (config/flag) may resolve the PR's managed worktree and run a
      fix/implementer constrained to surgical-fix discipline for conflict/CI only.
- [ ] After repair push, eligibility gates are re-evaluated before any merge retry; merge
      goes only through the existing `mergePr` / `pipeline merge` surface.
- [ ] Repair budget (max attempts and/or wall-clock) is enforced; exhaustion leaves the item
      held with evidence for a human.
- [ ] Unit tests (injected deps, no real network/git/subprocess) cover: conflict → hold;
      successful repair → re-eligible; budget exhaust → hold; no merge on red required checks.
- [ ] `npm run ci` is green; if `core/` changes, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `merge-queue-repair-hold`: hold reasons (`merge-conflict`, `checks-failed`), hold-and-
  continue (no force-merge), optional surgical repair in the managed worktree, bounded
  repair budget, post-repair re-gate, and merge retry only via the existing human merge
  surface.

### Modified Capabilities

- (none) — this change does not alter `merge-sub-command` gate semantics, pre-merge CI
  polling contracts, or surgical-fix prompt text; it **reuses** those surfaces from the
  merge-queue drive context. If a dedicated repair prompt is added later, it SHALL inherit
  surgical-fix discipline rather than weaken it.

## Impact

- Merge-queue drive implementation (sibling #674): hold recording, continue-vs-stop policy
  consistency, optional repair invocation hooks, re-eligibility before `mergePr`.
- Managed worktree resolution and fix/implementer harness entry points (reuse existing
  patterns; no second CI poller if pre-merge/merge check helpers can be shared).
- Operator-facing output of merge-queue apply/drive (held items, reasons, remediation).
- Config/flags for enabling optional repair and repair budget limits.
- Unit tests under `core/test/` with `MergeDeps`-style injected fakes.
- Depends on sequential drive (#674) merge primitive + hold policy; selection/dry-run (#673)
  for candidate set. Does not cut releases (#676) or add multi-repo trains.
- Golden rules preserved: human owns merge; no advance-loop merge; no `auto_merge` key.
