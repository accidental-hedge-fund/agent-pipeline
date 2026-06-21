## Why

Review state (verdict SHA, diff hash, blocking keys, risk tier) is currently encoded as four separate HTML-comment sentinels scattered across review comments and recovered via dedicated regex extractors. Adding a new dimension — or changing an existing one — requires touching four distinct sentinel definitions, four regex parsers, and multiple test fixtures, with no single place that represents the full review state for a comment. Future policy changes (e.g., a new gate dimension) carry meaningful risk of divergence between write and read paths.

## What Changes

- **New**: `ReviewArtifact` — a typed JSON struct that holds every machine-readable field a review comment currently writes as individual HTML-comment sentinels: `reviewedSha`, `diffHash`, `blockingKeys`, `review1Risk`, and `round`.
- **New**: A write helper (`buildReviewArtifact`) that produces the struct and embeds it as a single hidden `<!-- review-artifact: <base64-json> -->` block at the end of every review/delta comment.
- **New**: A read helper (`extractReviewArtifact`) that locates and decodes the structured block from a comment body; it is the **primary** read path for all gate logic.
- **Keep** (legacy fallback): the existing four individual sentinel extractors (`extractDiffHashFromComment`, `extractReview1Risk`, `extractBlockingKeys`, `extractVerdictSha`) continue to exist and are called only when `extractReviewArtifact` returns `null`, enabling old comments to keep working.
- **New**: The monolithic `review.ts` is split into five focused modules: `review-acquisition.ts` (fetch diff, comments, plan), `review-parsing.ts` (all extractors + artifact codec), `review-policy.ts` (partition, override, risk scaling — already partially separate), `review-rendering.ts` (comment assembly / body builders), and `review-routing.ts` (verdict → next-stage routing + gate loop).
- **Fixture tests**: test files cover round-trip encode/decode, old-sentinel fallback, and injection/spoofing resistance.

## Capabilities

### New Capabilities

- `review-artifact-record`: The `ReviewArtifact` struct and its encode/decode contract. Specifies the JSON shape, embedding format, primary-over-fallback precedence rule, and spoofing-resistance requirements.

### Modified Capabilities

- `review-sha-gating`: Requirement updated — the SHA gate SHALL read the reviewed SHA from the `ReviewArtifact` struct first (primary path) and fall back to the legacy `<!-- reviewed-sha: ... -->` sentinel only when no artifact is present.
- `verdict-diff-cache`: Requirement updated — the diff-hash cache SHALL read the diff hash from the `ReviewArtifact` struct first (primary path) and fall back to the legacy `<!-- verdict-diff-hash: ... -->` sentinel only when no artifact is present.

## Impact

- `core/scripts/stages/review.ts` — split into five modules (see above); sentinel write/read paths updated.
- `core/test/` — new fixture tests for `ReviewArtifact` round-trip, legacy-fallback, and injection hardening.
- `plugin/` — mirror must be regenerated after every `core/` change.
- No external API surface changes; the GitHub comment format is additive (new hidden block co-exists with existing sentinels on old comments and on new comments during the transition period).

## Acceptance Criteria

- [ ] Every new review/delta comment contains a `<!-- review-artifact: ... -->` block that decodes to a valid `ReviewArtifact` JSON object.
- [ ] All gate reads (SHA gate, diff-hash cache, blocking-keys check, risk-tier lookup) use `extractReviewArtifact` as the primary path and fall back to the individual sentinel extractors only when no artifact block is present.
- [ ] Old comments (no artifact block, only individual sentinels) are parsed correctly by the fallback path; all existing sentinel-extraction tests pass unchanged.
- [ ] An adversarially crafted body that embeds a `review-artifact` block before the pipeline footer does not corrupt gate reads (last-occurrence-wins or equivalent protection).
- [ ] The `review.ts` split produces five distinct modules; no module imports another in a cycle.
- [ ] `npm run ci` passes (tests + mirror sync) after the change.
