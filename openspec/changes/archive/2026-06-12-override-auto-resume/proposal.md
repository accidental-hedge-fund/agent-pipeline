## Why

`--override` records an audited disposition and clears `blocked`, then stops and prints "Re-run the pipeline to advance with the override applied." The human already made the judgment — the key and reason are the entire decision — so requiring a second manual invocation (and, for `needs-human`, also a manual relabel) is pure ceremony with no safety value.

## What Changes

- `runOverride` (`pipeline.ts`): after posting the override comment and clearing `blocked`, compute the resume stage (from the recorded ceiling comment if `needs-human`, otherwise the current label), flip the label when needed, and immediately enter the advance loop — exactly the call sequence a human would make manually.
- When the current stage is `needs-human`, read the `round` from the `## Pipeline: Review ceiling reached` comment (already parsed by `needsHumanPunchlist` / `REVIEW_CEILING_MARKER` logic), flip the label to `pipeline:review-<round>`, then advance.
- The advance loop re-runs `partitionFindings` against the now-present override sentinel; if remaining blockers exist the loop re-parks at `needs-human` (fail-safe).
- No change to `parseOverrideArg`, the sentinel format, the verdict schema, or any other stage.

## Capabilities

### New Capabilities
- `override-auto-resume`: After `--override` records an audited disposition, the pipeline SHALL automatically re-enter the advance loop rather than stopping and printing a re-run prompt.

### Modified Capabilities
- `review-severity-policy`: The `Audited operator overrides of individual findings` requirement gains a scenario covering the auto-resume behaviour that fires after the sentinel is posted.
- `pipeline-state-machine`: The `needs-human` handling in the advance loop and in `runOverride` gains a scenario covering the automatic label-flip from `needs-human` → `review-<round>` when `--override` is the entry point.

## Impact

- `core/scripts/pipeline.ts` (`runOverride`, and the `needs-human` branch in the advance loop): primary change site.
- `core/test/pipeline.test.ts` (or co-located): new unit tests for override-then-advance covering the three scenarios (all blockers resolved → advances; some remain → re-parks; `needs-human` label flip from ceiling round).
- No changes to prompts, plugin mirror aside from regeneration, or other stages.
