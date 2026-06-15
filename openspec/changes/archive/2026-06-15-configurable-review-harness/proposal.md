## Why

The reviewer harness is hardwired to the profile-assigned cross-harness role (e.g., `claude` profile always gets `codex` as reviewer) — a user cannot direct review to a different CLI without forking the profile. The `invokeReviewer` seam established by #39 already abstracts reviewer invocation; this issue makes the seam configurable per-repo by adding one optional key to `.github/pipeline.yml` and generalizing `invoke()` to accept an arbitrary CLI name.

## What Changes

- `core/scripts/types.ts` — the reviewer-selection type is widened so the reviewer role accepts an arbitrary string, not only the two built-in literals `"claude"` and `"codex"`.
- `core/scripts/harness.ts` — `invoke()` is generalized to accept a `string` harness parameter. Built-in harnesses retain their existing invocation shapes. For any other value, the CLI is invoked with the prompt as a positional argument; a spawn failure surfaces a specific, named message rather than `throw "Unknown harness"`.
- `core/scripts/self-review.ts` — `invokeReviewer` accepts `string` for the reviewer parameter so the generalized invoke path flows through (the implementing-harness fallback remains `Harness`).
- `core/scripts/config.ts` — `PartialConfigSchema` gains an optional `review_harness: string` key. When present, `resolveConfig()` overrides `cfg.harnesses.reviewer` with the configured value after the profile/file merge. The deleted `harnesses:` block remains absent and still rejected.
- `README` — documents `review_harness`, its semantics, and what a reviewer CLI must produce (a fenced JSON block matching the verdict schema the pipeline gates on).

## Capabilities

### New Capabilities
- `configurable-review-harness`: The `review_harness` config key, the generalized `invoke()` seam that accepts an arbitrary CLI name, and the specific, actionable failure path when the configured reviewer CLI is unavailable.

### Modified Capabilities
- `pipeline-configuration`: `review_harness` is added to the strict `PartialConfigSchema`; the "harness roles from profile only" requirement is updated to reflect the reviewer-override exception (the implementer remains profile-only).
- `cross-host-profiles`: "The profile selects the per-role harness" is updated to reflect that the reviewer role can be overridden by `review_harness`.

## Impact

`core/scripts/{types.ts,harness.ts,self-review.ts,config.ts}`, `README`, and co-located unit tests. No changes to the state-machine edges, review-stage logic, verdict schema, or any other pipeline stage.
