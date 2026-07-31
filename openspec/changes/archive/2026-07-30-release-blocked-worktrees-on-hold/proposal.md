## Why

Durable-loop items that **block or wait** (CI, OpenSpec, unresolved review, needs-human, etc.) keep their managed worktrees on disk. Those worktrees still count toward `max_concurrent_worktrees` (default 5) via `listActive`, because only closed issues and `pipeline:ready-to-deploy` are excluded. Once enough items park with worktrees retained, every subsequent schedulable item fails `createWorktree` with “At worktree capacity (5/5)…”. Those failures are recorded as per-item `blocked` / `blocked_needs_human` human holds, so the queue **cascades**: the factory self-deadlocks even though remaining issues are otherwise ready. Observed on milestone `v1.29.0` run `loop-4d2de11c6c029a2f-s1` (#673 → #674 → #675 capacity false-blocks after pre-merge holds filled capacity). This is a **resource leak that starves new starts**, distinct from #712 ledger stranding (which prevents *progress* on an item). Manual `git worktree remove` of clean parked trees unstuck a later item — proving retention, not issue content, was the wall.

## What Changes

- **Policy A (chosen):** On durable park / non-transient hold (needs-human, blocked wait, and equivalent non-active advance holds), the pipeline **releases** the issue’s managed worktree when it is safe: worktree is under the managed root, working tree is clean, and the branch tip is on the remote (or an open PR already exists for that head). Capacity frees for other items. On resume / unblock / re-advance, the worktree is recreated via the existing create path (same-issue reclaim rules preserved).
- **Unsafe park keeps the tree:** Dirty workdirs, local-only (unpushed) commits, unverifiable local-only state, or missing remote branch/PR **retain** the worktree (fail-closed; no silent discard). Operator messaging names the retain reason.
- **Capacity is not a product needs-human offramp:** When the sole failure is worktree capacity, the outcome MUST NOT be classified as product-judgment / answer-the-human needs-human. Prefer a distinct **ops/capacity** disposition (admission hold / non-human-blocking wait) so the durable loop does not cascade false `blocked` + human answer requests on every remaining pending item.
- **Residual full capacity (all slots truly active):** If after release policy every remaining slot is held by genuinely active (non-parked) work, the loop SHALL stop admitting new starts with a clear `worktree_capacity` (or equivalent) run-level reason rather than marking each leftover pending item as a human product block.
- **Same-issue reclaim unchanged:** An issue still does not count against itself; create-time same-issue reclaim and capacity exclusion for `issueNumber === current` remain.
- **Docs:** Operator-facing docs state what counts as active, when parked worktrees are released vs retained, how to recover, and that `pipeline:cleanup` is merge-only (does not free open blocked PRs).

## Capabilities

### New Capabilities

- `parked-item-worktree-release`: On durable park/hold, release clean managed worktrees when remote branch/PR exists so `max_concurrent_worktrees` capacity frees; re-create on resume; fail-closed retain when unsafe.
- `worktree-capacity-admission`: Capacity failures and residual full capacity are ops/admission dispositions — not product needs-human cascades; loop-level stop or non-human wait when only capacity remains.

### Modified Capabilities

- `worktree-lifecycle`: Capacity still gates on active managed worktrees; after park-release, parked issues without on-disk worktrees no longer occupy slots; same-issue reclaim / “this issue does not count against itself” preserved; capacity error remains explicit and machine-distinguishable.
- `blocked-recovery-recipes`: Capacity / ops worktree admission is distinct from generic `needs-human` product judgment (kind and recipe text distinguish “wait / free capacity / reschedule” from “answer a product decision”).
- `loop-needs-human-blocker-disposition`: Pure capacity outcomes MUST NOT be recorded as needs-human product holds that request human answers; they route to capacity admission / ops wait instead.

## Impact

- **Code (implementation phase, not this step):** `core/scripts/worktree.ts` (capacity identity, release helper reusing remove safety), park/block terminal paths in advance / pipeline-run / durable supervisor (release-on-hold hook), planning create failure classification, possibly `BlockerKind` + recipes, loop admission selection when capacity is the only barrier.
- **Tests:** Regression: N parked issues each would have held a worktree; under Policy A they release when safe so issue N+1 can create; capacity-only failure does not cascade N per-item human blocks; same-issue reclaim still works at cap 1; dirty/local-only park retains worktree.
- **Docs:** README / loop operator section for capacity policy and recovery.
- **Out of scope:** Raising the default cap as the only fix; #712 resume/`pr_opened` stranding; #714 OpenSpec skip-then-block; #716 docs:check pre-PR; deleting developer checkouts with `underManagedRoot: false`; changing merge-only `pipeline:cleanup` into a blocked-PR sweeper (document only).
- **Mirror:** After any `core/` edit, regenerate `plugin/` via `node scripts/build.mjs` in the same commit; `npm run ci` must pass.

## Acceptance criteria

Observable, falsifiable outcomes that make #718 done:

- [ ] After ≥ `max_concurrent_worktrees` issues park with durable non-transient holds and each would previously have retained a managed worktree, a **new** dependency-ready pending item is not hard-blocked solely because those parked siblings still occupy capacity **when release preconditions hold** (clean + remote branch or open PR): either create succeeds because slots were freed, or (if residual true-active capacity remains) the run stops or holds **admission** with a capacity reason and does **not** stamp each remaining pending item `blocked` + product needs-human.
- [ ] On durable park/hold for a managed worktree that is clean, under the managed root, and has a pushed branch tip (or open PR for that head), the pipeline removes that worktree from disk (and deregisters it) so it no longer appears in the active capacity count; the remote branch and open PR are not deleted as part of release.
- [ ] On durable park/hold when the worktree is dirty, has local-only commits, is unverifiable for local-only state, or has no remote branch/PR, the worktree is **retained** and the retain reason is visible to operators (log and/or blocker text); no silent discard of recoverable work.
- [ ] Resume / unblock / re-advance of a released issue recreates a worktree via the normal create path; same-issue stale reclaim and “this issue does not count against itself” behavior still hold (including at `max_concurrent_worktrees: 1` for self-retry).
- [ ] When the only failure reason for starting an item is worktree capacity, the disposition is **not** product-judgment needs-human / “answer the human” offramp text; blocker or hold text distinguishes capacity/ops from product needs-human.
- [ ] Unit (or injected-deps) regression test: simulate N parked issues contributing active managed worktree records (pre-fix) or post-release absence; starting issue N+1 follows Policy A (create succeeds after release, or admission stops without cascading per-item capacity human blocks). The test fails without the fix.
- [ ] Operator-facing docs state: what counts toward `max_concurrent_worktrees`, when parked worktrees are released vs retained, how capacity failures are dispositioned, and that `pipeline:cleanup` is merge-only and does not free open blocked-PR worktrees.
- [ ] `npm run ci` is green; if `core/` changed, `plugin/` is regenerated in the same change set.
