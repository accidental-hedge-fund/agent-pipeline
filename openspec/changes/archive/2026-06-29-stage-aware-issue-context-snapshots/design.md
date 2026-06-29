## Context

The pipeline already classifies human comments for the plan-revision step (`human-plan-feedback` spec): it scans comments posted after `## Implementation Plan` and filters out pipeline headers. This change extends that classification earlier (to all comments before and during the pipeline), formalizes it into a reusable `classifyComment` utility, and introduces a snapshot artifact that is built once at planning time and threaded through subsequent stage prompts.

The existing `last30days-context` spec provides a precedent for injecting bounded external context into the planning prompt; this change follows the same injection pattern using a new `{{context_snapshot}}` placeholder.

## Goals / Non-Goals

**Goals:**
- One pre-planning pass that collects, classifies, bounds, and persists the human-comment context as a first-class pipeline artifact.
- Stage-specific consumption: snapshot in planning/plan-review/review/shipcheck; suppressed from fix rounds.
- Lightweight conflict detection at planning time to surface body-vs-comment disagreement.
- Detection of new human comments posted after the revised plan, preventing silent scope expansion.

**Non-Goals:**
- Feeding every issue comment verbatim into every prompt (the point of bounding is to avoid this).
- Semantic reranking or AI-based deduplication of comments (simple chronological inclusion up to the size cap).
- Changing authority rules — issue body and explicit override comments remain authoritative over untrusted commenter text.
- Auto-merging or auto-approving scope changes surfaced by new comments.
- Parsing and acting on pipeline commands embedded in human comments (those remain the domain of override/scope-override patterns).

## Decisions

**Decision: Comment classification uses header-prefix matching, not author identity.**
Pipeline-authored comments always begin with a recognized header (`## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review 1`, `## Review 2`, `## Fix N`, `## Pipeline:`, `## Pre-Planning Context`). Any comment body that does not begin with one of these strings is treated as human. This is consistent with the header set already established in the `human-plan-feedback` spec and avoids a GitHub API call for author identity on every comment.

**Decision: Snapshot is built once at pre-planning time and persisted as the `## Pre-Planning Context` comment.**
Rebuilding the snapshot at each stage would pull in new comments that arrived after planning and blur the boundary between "context considered during planning" and "new input requiring re-plan". Instead, the snapshot is built exactly once before the planning harness runs. Later stages read the snapshot from the already-posted `## Pre-Planning Context` comment, not from a fresh comment fetch.

**Decision: Size bounding via character truncation of the oldest comments.**
The snapshot accumulates human comment bodies in chronological order. If the accumulated character count exceeds the configured limit (default: 8 000 characters), the oldest comments are dropped first and a truncation notice is appended to the snapshot noting how many comments were omitted and the total character count dropped. Semantic ranking was considered but adds model latency and a new harness call; simple chronological truncation is deterministic and testable.

**Decision: Conflict detection is structural (named-entity and negation heuristics), not semantic.**
Full semantic conflict detection requires a harness call and adds a convergence risk if the conflict detector itself produces false positives that block planning. Instead, the pipeline performs a lightweight structural check: compare the issue-body text against the concatenated snapshot text for (a) explicit negation phrases ("not", "do not", "exclude", "out of scope") modifying a noun also present in the body, and (b) named entities in the snapshot that contradict named entities in the body. When a potential conflict is detected, the pipeline appends a warning block to the planning prompt and the plan-review prompt, rather than blocking the pipeline.

**Decision: Post-revised-plan new-comment detection uses timestamp comparison.**
After the revised plan comment is posted, any human comment with a `created_at` timestamp after the revised-plan comment's `created_at` is flagged as new unacknowledged input. The pipeline surfaces this at the next stage boundary (before review or before the next fix round) by posting a `## Pipeline: New human input detected` warning comment and logging a human-intervention event. It does NOT block the pipeline or inject the comment into the stage prompt without acknowledgement.

**Decision: `{{context_snapshot}}` placeholder is present in planning/plan-review/review prompts; fix-round prompt templates do not include it.**
This is implemented by adding the placeholder to `planning.md`, `plan-review.md`, and `review.md` (and `shipcheck.md` if present), and explicitly NOT adding it to `fix.md`. The prompt-loader's existing placeholder injection mechanism renders the block only when the placeholder is present; omitting it from fix-round templates is the complete suppression mechanism — no conditional logic needed.

## Risks / Trade-offs

- *Classification false negatives*: A human comment that happens to begin with a pipeline header string (e.g., a maintainer manually copying a pipeline output) will be misclassified as pipeline-authored and excluded from the snapshot. Mitigation: the `## Pre-Planning Context` artifact is posted before planning runs; a maintainer can catch this by reviewing the artifact.
- *Truncation drops important context*: Chronological oldest-first truncation may drop comments that contain the most relevant scope clarifications if they were posted early. Mitigation: the snapshot notes exactly which comments were truncated; a maintainer can manually edit the issue body to include critical context.
- *Conflict detection false positives*: The structural heuristic may flag non-conflicting phrasing (e.g., "this is not the same as X" explaining a distinction, not a negation). Mitigation: conflicts are warnings in the planning prompt, not hard blocks; the planning harness exercises judgment before escalating.
- *Post-revised-plan warning is noisy*: If many comments arrive during a long implementation, each new comment triggers another warning. Mitigation: warnings are batched — the pipeline posts one `## Pipeline: New human input detected` comment listing all unacknowledged comments since the last acknowledgement rather than one per comment.

## Open Questions

- Should the size limit (8 000 chars) be configurable via `pipeline.yml`? Recommendation: yes, add an optional `context_snapshot.max_chars` key, defaulting to 8 000.
- Should the shipcheck prompt also receive the snapshot? The issue suggests yes (it is a review-adjacent stage); confirm during implementation by checking the shipcheck prompt's existing context surface.
