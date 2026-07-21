## 1. Reframe the spec context section + add the fix-round spec-revision instruction

- [x] 1.1 `specContextSection` renders "must **stay consistent with**" (not "must satisfy"); returns `""` when spec context is absent (unchanged).
- [x] 1.2 `fix.md` gains an OpenSpec-conditional `{{spec_revision_instruction}}` block permitting spec-delta revision when a finding's fix changes described behavior, then `openspec validate <id>` in the same commit.

## 2. Validate spec deltas a fix round revises

- [x] 2.1 `enforceOpenspecSpecDeltaValidation` (fix.ts): if a fix changed any `openspec/changes/<id>/specs/**` file, run `openspec validate <id>`; a structural failure blocks the round. Injectable deps (`gitDiffFiles`, `openspecValidateItem`).

## 3. Emit the structured spec-divergence signal

- [x] 3.1 Add `SPEC_DIVERGENCE_CATEGORY` + `categoryMarker` + `reviewCommentFlagsSpecDivergence` (review-policy.ts).
- [x] 3.2 `formatReviewComment` (review.ts) renders each finding's `category` as a controlled marker so a deterministic gate can read it.

## 4. Pre-merge consistency guard (deterministic, never prose)

- [x] 4.1 `specDeltaIsStale` (pre_merge.ts): order-aware file-path check — impl files changed in a commit after the last `specs/**`-changing commit.
- [x] 4.2 `enforceSpecConsistencyGuard`: block before archive when `specDeltaIsStale` AND the latest review verdict carries `category: spec-divergence` (`reviewCommentFlagsSpecDivergence`) — never prose. Injectable deps via `AdvancePreMergeDeps`.
- [x] 4.3 `maybeArchiveOpenspec` calls the guard before `openspec archive`.

## 5. Tests

- [x] 5.1 Validation guard: spec changed + invalid → blocked; no spec change → ok; unavailable → ok.
- [x] 5.2 `specDeltaIsStale`: order-aware stale/not-stale cases.
- [x] 5.3 `maybeArchiveOpenspec`: stale + `category: spec-divergence` marker → blocked, no archive; same staleness but a finding that only mentions "diverges from spec" in PROSE (no marker) → archives normally (proves the gate ignores prose).

## 6. Mirror + CI

- [x] 6.1 `node scripts/build.mjs`; `npm run ci` green.
