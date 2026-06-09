## Why

The pipeline posts an implementation plan as a GitHub issue comment so humans can read it. But today the plan-revision step feeds only the reviewer harness's feedback back to the implementer — human comments left on the plan are silently ignored. A person who reads the plan and leaves a comment to redirect it has no actual influence on the revised plan that drives implementation.

## What Changes

- After the reviewer harness completes and before the revision prompt is built, the pipeline fetches the current issue comments and identifies **human comments**: comments posted after the `## Implementation Plan` comment whose body does not begin with a recognised pipeline comment header.
- If any human comments are found, they are passed to the revision prompt as a distinct labeled block alongside the reviewer harness feedback. The implementer harness is told to address both sources.
- The revised-plan comment posted to the issue lists the GitHub usernames of the human commenters whose feedback was incorporated.
- When no human comments are present, the pipeline behaves identically to today — no extra API calls affect the hot path and no comment format changes.

## Capabilities

### New Capabilities

- `human-plan-feedback`: Identification, filtering, and inclusion of human issue comments in the plan-revision step; attribution of incorporated human feedback in the revised-plan comment.

### Modified Capabilities

- `plan-revision`: The revision prompt gains a second feedback source (`human_feedback`) alongside the existing reviewer harness feedback. The revised-plan comment header is updated to attribute human commenters when present.

## Impact

- `core/scripts/stages/planning.ts` — re-fetch issue comments after reviewer harness; call the new filter helper; pass human feedback to revision prompt; update comment attribution.
- `core/scripts/prompts/plan_revision.md` — add `{{human_feedback}}` placeholder section after reviewer feedback.
- `core/scripts/prompts/index.ts` (`buildPlanRevisionPrompt`) — accept and interpolate the new `humanFeedback` parameter.
- `core/scripts/gh.ts` (or `planning.ts`) — new `extractHumanPlanComments()` helper.
- Tests — new unit tests for the filter helper and the revised revision prompt rendering.
