## 1. Shared finalize path

- [x] 1.1 Export `finalizeReviewArtifactComment(body, banners)` from `core/scripts/stages/review-parsing.ts`. Insert the banner block after the first newline, then call `rebindReviewArtifactBodyHash`.
- [x] 1.2 Keep `rebindReviewArtifactBodyHash` as the only hash writer after insert. Last `review-artifact` line only. Hash the exact prefix (strip one trailing `\n` when present). Preserve all other artifact fields. No-op when any non-whitespace follows the artifact.
- [x] 1.3 Point `reviewComment` in `review-routing.ts` at the shared finalizer. Do not keep a second insert+rebind copy.
- [x] 1.4 Point the initial delta post and the post-auto-fix re-review post in `pre-merge-sha-gate.ts` at the same finalizer. Do not post a bannered delta with a stale `bodyHash`.
- [x] 1.5 Do not add new banners. Do not change plan-review (`planning.ts`). Do not add an ack-gate heading/banner exemption.

## 2. Compatibility strip (read-side only)

- [x] 2.1 Tighten `stripEngineOwnedReviewBanners` to the four production line forms in design D7. Window = after heading, before `**Reviewer**:`.
- [x] 2.2 Do not strip a human line in that window, including markdown that only resembles a banner.
- [x] 2.3 New posts must verify on the exact prefix (`hashReviewBody(prefix) === bodyHash`) without needing the strip.

## 3. Tests

- [x] 3.1 `formatReviewComment` + `finalizeReviewArtifactComment` with a coverage banner → `isVerifiedPipelineReviewOutput` true and `isVerifiedPipelineOutput` true. Exact-prefix hash equals recorded `bodyHash`.
- [x] 3.2 Same wrapper with multiple banners (coverage + ensemble + self-review), including `\n\n` boundaries → both verifiers true; exact-prefix hash equals `bodyHash`.
- [x] 3.3 `formatDeltaReviewComment` + the same wrapper → both verifiers true.
- [x] 3.4 Verified review-2 body with `\binstead\b` in finding text, author = pipeline actor → `findUnacknowledgedComments` returns [].
- [x] 3.5 Free-form human comment after the revised-plan anchor → still returned.
- [x] 3.6 Human objection in the review prefix (not an allowlisted banner) → verify false and still counted when it matches `NEGATION_PATTERNS`.
- [x] 3.7 Unverified trusted-actor review-shaped body with objection wording → still counted.
- [x] 3.8 Human line among valid banners, including `**Reviewer coverage (#694):** please do X instead` and `**Ensemble** (please do not merge)` → strip does not accept; verify false.
- [x] 3.9 Rebind preserves non-`bodyHash` artifact fields. Rebind is a no-op when a suffix follows the artifact.
- [x] 3.10 Tests inject deps. No real network, git, or subprocess.

## 4. Mirror and gate

- [x] 4.1 After `core/` edits, run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [x] 4.2 Run `npm run ci`. Do not claim green until that command exits 0.
