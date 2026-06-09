## Context

The plan-revision step lives inside the `steps.plan_review` guard in `core/scripts/stages/planning.ts` (lines 107–151). The current sequence is:

1. Reviewer harness runs against the posted plan and returns feedback (`planReview`).
2. `buildPlanRevisionPrompt({ …, feedback: planReview })` builds the revision prompt.
3. Implementer harness revises the plan.
4. Revised plan is posted as `## Revised Implementation Plan`.

`getIssueDetail()` (`core/scripts/gh.ts`) already returns all issue comments with `author`, `body`, and `createdAt`. `findLatestCommentMatching()` shows the established pattern for searching comments by content predicate. No new GitHub API surface is needed.

The reviewer harness invocation is not instant (typically 30 s – 3 min). During that window a human can read the freshly posted plan and leave a comment. Fetching comments again immediately before building the revision prompt captures anything that arrived during the reviewer run without adding a pause to the happy path.

## Goals / Non-Goals

**Goals:**
- Pick up human comments that arrive between plan-posting and the revision step.
- Pass human comments to the implementer as a clearly labeled second feedback source.
- Attribute incorporated human commenters in the revised-plan comment.
- Zero behavior change when no human comments are present.

**Non-Goals:**
- Pausing the pipeline to wait for human comments (that is issue #23).
- Incorporating PR review comments or comments on other issues.
- Supporting human feedback when `steps.plan_review` is disabled (there is no revision step to augment).
- Requiring any per-repo configuration — the feature activates automatically.

## Decisions

### Decision 1: Filter human comments by content, not by author

**Rationale:** The pipeline posts comments starting with recognised Markdown section headers (`## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`). Human comments generally do not; and requiring a configured `bot_user` field adds config burden for repos that don't have a dedicated bot account.

Content-based filtering works without config: a comment posted after the plan comment whose body does not begin with a known pipeline header is treated as human.

Known pipeline headers to exclude: `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review 1`, `## Review 2`, `## Fix 1`, `## Fix 2`.

**Alternatives considered:**
- Filter by author against a configured `bot_user` — rejected: adds required config, bot identity may change.
- Embed `<!-- pipeline -->` sentinel in all pipeline comments — more robust for edge cases but is a broader change beyond this issue's scope; can be adopted later as a hardening pass.

### Decision 2: Re-fetch comments immediately before building the revision prompt

**Rationale:** The `detail` object fetched at the top of `advance()` predates the plan comment itself, so no human comment on the plan can exist in it. Re-fetching after the reviewer harness completes costs one extra `gh issue view` call but captures the maximum possible human input window (the reviewer run time).

**Alternatives considered:**
- Reuse the existing `detail` — rejected: logically impossible to contain comments on the plan since the plan hadn't been posted yet.
- Poll periodically while the reviewer runs — rejected: adds complexity and the reviewer is synchronous; a single re-fetch at the end is sufficient.

### Decision 3: Pass human feedback as a distinct `{{human_feedback}}` placeholder in the revision prompt template

**Rationale:** Keeping the two feedback sources separate in the prompt gives the model clear provenance for each piece of feedback. When `humanFeedback` is empty the placeholder resolves to an empty string, making the rendered prompt identical to today's output.

**Alternatives considered:**
- Concatenate both into the existing `{{feedback}}` field — simpler but loses source distinction; the model cannot tell which feedback came from the automated reviewer vs. a human.

### Decision 4: List human commenters in the revised-plan comment header

**Rationale:** The revised-plan comment already attributes the reviewer harness (`**Based on review by**: ${reviewer}`). Adding `**Human feedback from**: @author1, @author2` when human comments were incorporated makes it visible in the PR/issue timeline that human steering reached the plan — without requiring anyone to read the full prompt log.

When no human feedback is present the comment header is unchanged.

## Risks / Trade-offs

- **False positives** — a human comment beginning with `## Implementation Plan` (e.g., a quote) would be filtered out. This is an acceptable edge case; the filter errs on the side of over-excluding rather than passing pipeline noise to the revision.
- **Timing** — if a human comments during the revision harness run (after the re-fetch), their comment is not included in this cycle. It will be picked up on the next pipeline trigger. Acceptable given the no-mandatory-pause constraint.
- **Extra `getIssueDetail()` call** — one additional GitHub CLI call per plan-review step. Negligible cost.

## Open Questions

- Should `extractHumanPlanComments` live in `gh.ts` (alongside the other comment helpers) or inline in `planning.ts`? Prefer `gh.ts` for discoverability alongside `findLatestCommentMatching`.
