## 1. Auto-resume in runOverride

- [x] 1.1 After posting the override comment and clearing `blocked`, read the current stage label from the issue detail already fetched in `runOverride`.
- [x] 1.2 If the stage is `needs-human`: parse the ceiling comment (via `REVIEW_CEILING_MARKER`) to extract the `round` value; error with a clear message if no ceiling comment is found.
- [x] 1.3 If the stage is `needs-human`: flip the label to `pipeline:review-<round>` (remove `needs-human`, add `review-<round>`) before entering the advance loop.
- [x] 1.4 Call `runAdvance` (with the existing `opts`) rather than printing the "Re-run the pipeline" prompt — drop that log line.

## 2. Unit tests (injectable deps — no real network/git)

- [x] 2.1 **All blockers overridden → advances**: mock `partitionFindings` to return zero remaining blockers after override; assert the advance loop is entered and the item advances to the next stage.
- [x] 2.2 **Some blockers remain → re-parks**: mock `partitionFindings` to return one remaining blocker; assert the loop re-parks at `needs-human` and does not advance past the unresolved finding.
- [x] 2.3 **needs-human label flip**: mock issue at `needs-human` with a ceiling comment encoding `round: 2`; assert `runOverride` flips the label to `pipeline:review-2` before calling the advance loop.
- [x] 2.4 **Missing ceiling comment → error**: mock issue at `needs-human` with no ceiling comment; assert `runOverride` errors with a clear message and does not enter the advance loop.
- [x] 2.5 **Non-needs-human stage**: mock issue at `blocked` in `review-1`; assert no label flip occurs and the advance loop is entered directly from `review-1`.

## 3. Mirror + CI

- [x] 3.1 `node scripts/build.mjs` — regenerate plugin mirror.
- [x] 3.2 `npm run ci` — all gates green.
