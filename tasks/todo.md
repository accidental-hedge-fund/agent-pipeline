# #1028 — train∘loop ship path autonomy

## Plan

- [x] OpenSpec validate `train-loop-ship-path-autonomy`
- [x] #1020 engine-scratch recover (`unlink_engine_scratch` before repair)
- [x] #1025 stale blocked re-review on enter
- [x] #1023 train base-eligible frontiers + one advance-wave per frontier
- [x] #1021 engine-class live sibling auto-file
- [x] plugin mirror + docs regenerate
- [ ] `npm run ci` green
- [ ] Commit with Issue/Pipeline-Run trailers

## Review

### What changed

- Recovery: `unlink_engine_scratch` recipe + default order before `repair_pipeline_item` on workflow-engine-defect
- Advance: stale-block resume clears leftover `blocked` when HEAD past reviewed-sha with non-internal commits
- Train: frontier waves via `advanceWave` / multi-item loop; independent merge while peer parked
- Live sibling: ready-labeled milestone sibling after engine-scratch recover

### Verification

- Targeted unit suites for train, recovery, stale-block, live sibling, worktree-dirt
- Full `npm run ci` pending
