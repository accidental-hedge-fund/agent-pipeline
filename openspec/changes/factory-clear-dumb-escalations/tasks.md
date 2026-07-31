## 1. Implementation

- [x] 1.1 Export marker strip helpers from `salvage-harness-work.ts`
- [x] 1.2 Pre-archive cleanliness uses strip; marker-only cleans and proceeds
- [x] 1.3 `isAutoFixableFinding` accepts code-behind-spec
- [x] 1.4 Unit tests for both behaviors

## 2. Specs

- [x] 2.1 Delta `pre-merge-fix-round` for directional autofix
- [x] 2.2 Delta archive/marker cleanliness (via harness-uncommitted-salvage alignment note + archive scenarios)

## 3. Verification

- [ ] 3.1 `cd core && npm test` green
- [ ] 3.2 `node scripts/build.mjs` mirror in sync
