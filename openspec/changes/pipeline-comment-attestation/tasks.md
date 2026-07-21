## 1. Audit

- [x] 1.1 Enumerate every comment type the engine posts to an issue or PR (grep `postComment`/`postPrComment` call sites and heading literals across `core/scripts/`), recording heading, builder function, and file.
- [x] 1.2 For each, record whether it already carries a verifiable artifact (`review-artifact` with `bodyHash`) and whether its rendered body trips `NEGATION_PATTERNS`.

## 2. Attestation primitive

- [x] 2.1 Add `encodePipelineAttestation({ kind, bodyHash })` / `attestPipelineComment(kind, body)` and `isVerifiedPipelineAttestation(body)` in `core/scripts/stages/review-parsing.ts`, mirroring the `review-artifact` rules: base64url payload on a single HTML-comment line, last-occurrence-wins, nothing after the marker, `bodyHash` recomputed over the preceding text.
- [x] 2.2 Export `isVerifiedPipelineOutput(body)` = verified review artifact OR verified attestation.
- [x] 2.3 Unit tests: valid attestation verifies; trailing text after the marker fails; tampered body fails; malformed/undecodable payload fails; a marker injected before the footer does not win.

## 3. Registry and posting path

- [x] 3.1 Add the single-sourced `PIPELINE_COMMENT_KINDS` registry (kind id + heading + builder reference) in `core/scripts/gh.ts`.
- [x] 3.2 Add the attesting post helper and route every pipeline comment post through it.
- [x] 3.3 Recognize the attestation marker as a pipeline structural marker in `classifyComment`.
- [x] 3.4 Attest each comment type found in task 1.1, starting with `advisoryAdvanceComment` in `core/scripts/stages/review-rendering.ts`; leave review verdicts on the existing `review-artifact` path.

## 4. Gate

- [x] 4.1 In `core/scripts/issue-context-snapshot.ts`, replace `isVerifiedPipelineReviewOutput` with `isVerifiedPipelineOutput` in `findUnacknowledgedComments`; leave trust checks and `NEGATION_PATTERNS` untouched.
- [x] 4.2 Update the surrounding contract comment to describe the generalized verified-output rule and the unchanged no-legacy-path stance.

## 5. Tests

- [x] 5.1 Regression test replaying the observed #429 history: plan anchor → `## Pipeline: Review 1 advanced under severity policy` from the pipeline actor → `findUnacknowledgedComments` returns `[]`. Prove it fails without the fix.
- [x] 5.2 Behavioral drift guard: iterate `PIPELINE_COMMENT_KINDS`, render each type, assert `isVerifiedPipelineOutput` is true and `findUnacknowledgedComments` returns `[]` for a trusted author.
- [x] 5.3 Source drift guard: scan `core/scripts/` for pipeline comment heading literals and fail on any absent from the registry (with a short justified allowlist).
- [x] 5.4 Negative cases: attested body from an untrusted author still counted; attested body with appended human text still counted; tampered `bodyHash` still counted; `NEGATION_PATTERNS` asserted unchanged.

## 6. Ship

- [x] 6.1 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [x] 6.2 `npm run ci` green from the repo root.
