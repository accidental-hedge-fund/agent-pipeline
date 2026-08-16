## Why

#1095 sat at `pipeline:fix-2` + `blocked` for ~2h after a 5s “unacknowledged human comment” park. The comment was Review 2 (`5309396300`, `## Review 2 (Adversarial)`), posted as the pipeline `gh` actor — not operator chat. `formatReviewComment` hashed the body, then `reviewComment()` inserted the #694 coverage banner (and can also insert ensemble / self-review banners). `isVerifiedPipelineReviewOutput` hashed the GitHub prefix and compared it to `bodyHash` → false. `findUnacknowledgedComments` then treated trusted-author + unverified + `\binstead\b` as human and set `needs-human`. The ack gate (#318) did not change. The attestation contract did.

## What Changes

- Posted review-1, review-2, and pre-merge delta bodies SHALL verify (`isVerifiedPipelineReviewOutput` / `isVerifiedPipelineOutput` true) after every engine-owned post-render insert (coverage, ensemble identity, self-review banners).
- The engine SHALL bind `bodyHash` after the last mutation of the hashed prefix, or hash a defined prefix that excludes a separately attested banner. It SHALL NOT mutate the hashed region after `bodyHash` is written.
- A verified pipeline review/delta comment that contains objection wording (`instead`, `do not`, …) SHALL NOT be returned by `findUnacknowledgedComments` when the author is the pipeline actor (or a trusted override actor).
- A real human comment after the revised plan SHALL still be counted and SHALL still block.
- Already-posted v1.39.1 comments whose `bodyHash` predates the banner MAY keep a read-side engine-owned-banner strip so they verify. That path is compatibility, not the class law for new posts.
- Coverage disclosure (#694) stays. The human-ack gate is not weakened for actual operator comments.

## Acceptance Criteria

- [ ] Unit: `formatReviewComment` plus the production coverage / ensemble / self-review wrapper produces a body for which `isVerifiedPipelineReviewOutput` (and `isVerifiedPipelineOutput`) is true.
- [ ] Unit: the same wrapper on `formatDeltaReviewComment` also verifies.
- [ ] Unit: that verified review-2 body plus `\binstead\b` in the finding text is **not** returned by `findUnacknowledgedComments` when the author is the pipeline actor.
- [ ] Unit: a free-form human comment after the revised plan **is** still returned by `findUnacknowledgedComments`.
- [ ] Unit: a human objection inserted into a review prefix (not an engine-owned banner line) still fails verification and still counts as unacknowledged when it matches `NEGATION_PATTERNS`.
- [ ] Unit tests inject deps (no real network, git, or subprocess). If `core/` changes, regenerate `plugin/`. `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `review-artifact-record`: Posted review/delta `bodyHash` SHALL bind the final posted prefix, including engine-owned coverage / ensemble / self-review banners. The engine SHALL NOT mutate that hashed region after the hash is written unless it rebinds `bodyHash` as the last step before post.
- `issue-context-snapshot`: A trusted-actor review/delta comment that verifies after those banners SHALL NOT be counted as unacknowledged human input even when the body contains objection wording. A real human comment after the plan still is.

## Impact

- **Primary (intent for implement):** review render + post wrapper — `formatReviewComment` / `formatDeltaReviewComment` in `core/scripts/stages/review-rendering.ts`, banner insert + last-hash bind in `core/scripts/stages/review-routing.ts`, verification in `core/scripts/stages/review-parsing.ts`. Ack-gate consumer `findUnacknowledgedComments` in `core/scripts/issue-context-snapshot.ts`. Tests in `core/test/review-artifact.test.ts` and `core/test/issue-context-snapshot.test.ts`.
- **Out of scope:** weakening the human-ack gate for actual operator comments; deleting coverage disclosure (#694); unblocking #1095 (operator / separate resume); changing train leftover-block (#1095) or in-engine ship (#1096).
- **Program:** v1.39.2. Independent of #1095 and #1096. Observed on #1095 Review 2 / PR #1097.
- **Class vs site (engine-dogfood bar):** this is a **class** fix. The class is “engine-owned mutation of an attested body after `bodyHash` is written.” The #694 coverage banner is the observed site. Ensemble and self-review banners are the same class. The next engine-owned insert on a review/delta comment must not need a new mole issue.
