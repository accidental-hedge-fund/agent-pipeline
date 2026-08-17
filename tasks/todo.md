# #1041 Revised plan — refuse no-frg production pin

## Status
- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation

## Results
- Default `promoteProductionPin` refuses `no-frg-*` / missing FRG / null evidence and does not mutate the pin.
- Non-skip success writes the FRG `run_id` and a non-null evidence path.
- `--skip-frg` / `allowWithoutFrg` still writes `no-frg-<version>` + null evidence.
- Same-version `no-frg-*` is not already-current unless skip is active.
- Factory pinned `evaluateEngineTrackCheck` fails a matching-version `no-frg-*` pin.

## Locked decisions (post-review)

1. Command split is not shared skip. `pipeline factory-pin promote` is FRG-only. `pipeline engine-promote` may use `resolveFrgSkip`.
2. One exported predicate `isProductionQualityPin` is used by default promote, already-current, and factory pinned doctor.
3. All FRG validation runs before any pin write. Every refusal leaves the pin file byte-for-byte unchanged.
4. Doctor fail-closed uses `isFactoryControlRepo` + `resolveEngineTrackIntent`. Non-factory (`intent === null`) and candidate soak do not fail solely for a `no-frg-*` pin.
5. OpenSpec change `openspec/changes/refuse-no-frg-production-pin/` is patched in place to match these locks.

See the chat revised implementation plan for Approach, API, tests, and acceptance criteria.
