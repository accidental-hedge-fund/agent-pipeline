## 1. Contracts and seams

- [x] 1.1 Confirm (or land alongside #673) the ordered candidate type consumed by drive (at least PR number; issue number and position as available from selection).
- [x] 1.2 Define `DriveDeps` (or equivalent) composing revalidation I/O, a `mergePr` callable / `MergeDeps`, and logging — no real network in unit tests.
- [x] 1.3 Verify any `gh pr view` fields used for already-done detection (`state`, `mergedAt`, etc.) with a live `gh` call before coding against them (rule #5).

## 2. Drive core

- [x] 2.1 Implement sequential `driveMergeQueue(candidates, deps)` (name may match module conventions) as a strict await loop over the ordered list.
- [x] 2.2 Implement pre-item revalidation: already-done → skip+continue; hard ineligible → record reason + fail-stop; eligible → proceed to merge.
- [x] 2.3 On eligible items, call existing `mergePr` only (thin logging wrapper allowed); never a second merge path.
- [x] 2.4 On `mergePr` success, continue to next; on throw, fail-stop and mark remaining not-attempted.
- [x] 2.5 Emit an operator-facing outcome summary (merged / skipped-already-done / failed / not-attempted + reasons).

## 3. CLI apply gating

- [x] 3.1 Wire merge-queue command so `--apply` (or the #673 confirm flag) is required to enter drive; default path remains dry-run with zero merges.
- [x] 3.2 Register apply-related flags on the command allowlist via `command-registry` as needed; reject unsupported flags before any merge.
- [x] 3.3 Ensure advance/dispatch paths do not import or call the drive entry point; extend loop-isolation coverage if needed.

## 4. Unit tests

- [x] 4.1 Test sequential single-flight order: two candidates → merge calls in order; second starts only after first settles.
- [x] 4.2 Test apply gating: without apply flag, zero merge calls.
- [x] 4.3 Test already-done skip continues to next candidate.
- [x] 4.4 Test hard revalidation failure fail-stops and leaves later candidates not-attempted.
- [x] 4.5 Test `mergePr` throw fail-stops with non-zero outcome and no further merges.
- [x] 4.6 Test successful full walk merges all eligible candidates in order.
- [x] 4.7 Assert drive uses `mergePr` (or recorded merge dep) rather than a bypass path; assert advance isolation.

## 5. Mirror and CI

- [x] 5.1 If `core/` changes, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 5.2 Run `npm run ci` from repo root and fix failures before marking the change done.
