## 1. Depth-agnostic node_modules scan in verify

- [x] 1.1 In `core/scripts/verify-harness-commits.ts`, replace the root-only check
      (`file.split("/")[0] === "node_modules"`) with a path-segment check that treats any
      path containing a full `node_modules` component as a hit (equivalent to
      `/(^|\/)node_modules(\/|$)/` on forward-slash git paths). Prefer a small named
      helper for clarity and unit-test reuse.
- [x] 1.2 Keep the existing diagnostic shape:
      `Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed`.
- [x] 1.3 Confirm the scan still runs first on non-empty ranges and still ignores
      delete-only paths (behavior of `gitDiffTreeFiles` / `--diff-filter=d` unchanged).

## 2. Regression tests

- [x] 2.1 Add a nested monorepo case in `core/test/verify-harness-commits.test.ts`
      (e.g. `apps/web/node_modules/.pnpm/...`) that expects `ok: false` and a reason
      naming the nested path.
- [x] 2.2 Make the nested case bite: assert (or structure the test so) that the legacy
      root-only leading-component check would not flag the nested path, proving the
      segment-aware check is load-bearing.
- [x] 2.3 Keep existing #180 root-level cases green (`node_modules`,
      `node_modules/foo`, empty range, delete-only cleanup, diagnostic-before-message).
- [x] 2.4 Optionally add a non-hit case where `node_modules` is only a substring of a
      path component (e.g. `src/node_modules_backup/x.ts`) if not already covered.
- [x] 2.5 Run the verify-harness-commits tests and confirm the nested case fails without
      the production fix and passes with it.

## 3. Mirror, CI, and scope guard

- [x] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated
      `plugin/` in the same change.
- [x] 3.2 Confirm salvage pathspec composition is untouched (no drive-by edits to
      `salvage-harness-work.ts` beyond parity documentation if needed).
- [x] 3.3 Run `npm run ci` from the repo root and fix any failures until green.
