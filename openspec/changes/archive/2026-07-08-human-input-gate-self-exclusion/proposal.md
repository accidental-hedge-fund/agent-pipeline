## Why

The human-input gate (`findUnacknowledgedComments`) decides whether a stage boundary is blocked by unacknowledged human comments. It filters comments purely by body-classification (`classifyComment`), which recognizes a fixed set of pipeline comment headers. Two headers the pipeline posts at pre-merge — the `## Pre-merge Delta Review` verdict and its follow-up re-review (also `## Pre-merge Delta Review`) — are **not** in that set, so the gate misreads the pipeline's own review output as human input.

In the single-operator case this is fatal: the pipeline necessarily posts under the operator's own `gh` identity, so author cannot distinguish the pipeline's comments from the operator's. castrecall #45 blocked a review-2 entry with "2 unacknowledged human comment(s)" — both were the pipeline's own delta-review needs-attention verdict and its follow-up approve. When the operator then posted an explanatory comment, it became a *third* unacknowledged item and re-blocked the resume; the only escape was posting a literal `## Pipeline: Scope override` heading as an acknowledgement anchor.

Pipeline-authored comments should be recognized by their **structural markers**, not by author, and the gate must never block against its own output. A plain acknowledgement from the trusted operator must also clear the gate without demanding a magic heading — while a third party who forges pipeline-styled headings must still be counted (the gate's forge-resistance, established in #229/#318, must not weaken).

## What Changes

- **Recognize the missing pipeline structural markers.** Expand the marker set used to classify a comment body as pipeline-authored to include `## Pre-merge Delta Review` and a generalized `## Review <N>` for any positive integer N (not just `## Review 1`/`## Review 2`), plus the pipeline machine-sentinel HTML markers (`<!-- pipeline-audit:`, `<!-- pipeline-override`, `<!-- pipeline-override-scope`, `<!-- pipeline-blocking-keys`, `<!-- pipeline-blocking-surfaces`, `<!-- reviewed-sha`). A comment carrying any of these is *structurally* pipeline output.
- **Author-gate the marker-based exclusion at the gate.** A structurally-pipeline comment is excluded from the unacknowledged-human-input count only when its author is the authenticated pipeline actor (`getGhActor`) or an entry in `trusted_override_actors`. A comment from any other author that merely mimics pipeline headings is still counted as human input. This is the existing trust path (`buildTrustedOverrideComments`) applied to the gate — forge resistance is preserved, and in the single-operator case the operator *is* the actor so the pipeline's own comments (posted under the operator's login) are correctly excluded.
- **Accept a plain acknowledgement as an anchor.** A comment authored by a trusted actor after the plan anchor that contains no scope-changing / change-request language SHALL act as an acknowledgement anchor — dismissing prior unacknowledged human comments — without requiring the literal `## Pipeline: Scope override` heading, and SHALL NOT itself become a new unacknowledged item on the next resume. A trusted-actor comment that *does* carry scope-changing language, and any comment from a non-trusted author, still gates exactly as today.

## Capabilities

### Modified Capabilities
- `issue-context-snapshot`: The comment-classification requirement gains the delta-review / generalized-review / sentinel-HTML structural markers. The unacknowledged-human-input gate becomes author-aware (marker-based exclusion applies only to trusted-actor comments) and accepts a plain trusted-actor acknowledgement as an anchor.

## Acceptance criteria

- [ ] `classifyComment` classifies a `## Pre-merge Delta Review …` body and a `## Review <N>` body (for any positive integer N) as `pipeline`, and continues to classify a body with no recognized pipeline marker as `human`.
- [ ] The gate (`findUnacknowledgedComments`) excludes a structurally-pipeline comment from the unacknowledged count only when its author is the pipeline actor or a `trusted_override_actors` entry; a pipeline-styled body from any other author is counted as human input.
- [ ] The castrecall #45 scenario passes: a review-2 entry whose only comments since the last anchor are the pipeline's own `## Pre-merge Delta Review` needs-attention verdict and its follow-up approve — both under the operator's (actor's) login — produces **zero** unacknowledged human comments and does not block.
- [ ] A trusted-actor comment with no scope-changing keywords acts as an acknowledgement anchor without the literal `## Pipeline: Scope override` heading, dismisses prior unacknowledged human comments, and does not itself count as a new unacknowledged item on the next resume.
- [ ] A trusted-actor comment that contains scope-changing / change-request language still counts as unacknowledged human input, and a comment from a non-trusted author still counts even if it mimics pipeline headings.
- [ ] Regression tests drive `findUnacknowledgedComments` (and `classifyComment`) through the deps seam covering: pipeline-authored delta-review bodies under the operator's login (excluded), a forged pipeline-styled body from a different author (counted), the plain-acknowledgement anchor flow (prior comments dismissed, anchor not re-counted), and a scope-relevant trusted comment (still counted). Each test fails without the corresponding change.

## Impact

- `core/scripts/gh.ts` — `PIPELINE_COMMENT_HEADERS` / `classifyComment`: add `## Pre-merge Delta Review`, generalize `## Review <N>`, and recognize the pipeline sentinel-HTML markers as structural pipeline markers.
- `core/scripts/issue-context-snapshot.ts` — `findUnacknowledgedComments`: author-gate the pipeline exclusion using the already-passed trusted-actor comment set, and add the plain-acknowledgement anchor branch. The scope-changing-language test reuses the existing `NEGATION_PATTERNS`.
- `core/test/issue-context-snapshot.test.ts` (and `gh` classification tests) — new regression coverage for the four scenarios above.
- No state-machine edges, review schema, or `review_policy` semantics change. No new config key (out of scope: which keywords mark a comment scope-changing; dedicated bot identities).
- `plugin/` mirror regenerated via `node scripts/build.mjs`.
