## 1. Extend `MergeDeps` with `ghPrChecksAll`

- [x] 1.1 Add `ghPrChecksAll(prNumber: number): Promise<Array<{ name: string; bucket: string }>>` to the `MergeDeps` interface in `core/scripts/stages/merge.ts`
- [x] 1.2 Implement the production default: call `gh pr checks <pr> --json name,bucket` via `ghRun` (consistent with the existing `ghPrChecksRequired` default), parse JSON, and return the array
- [x] 1.3 Verify the field names against real `gh pr checks --json name,bucket` output to avoid a shape mismatch (run `gh pr checks <any-pr> --json name,bucket` and confirm)

## 2. Add the "no required checks" fallback path in the gate logic

- [x] 2.1 Locate the `ghPrChecksRequired` call in the required-checks gate; wrap its error handling to detect the "no required checks reported" substring in the `gh` stderr
- [x] 2.2 When that substring is present, invoke `ghPrChecksAll` and collect the result
- [x] 2.3 If any check bucket is `fail`, `pending`, or `cancel`, exit non-zero with a message naming the offending check(s) and their buckets — do not merge
- [x] 2.4 If all checks are `pass` or `skipping` (or the list is empty), proceed to the issue-stage gate
- [x] 2.5 Any other non-zero exit from `ghPrChecksRequired` (not the empty-set message) remains a hard error

## 3. Unit tests

- [x] 3.1 Add a test: fake `ghPrChecksRequired` returns the "no required checks" error AND `ghPrChecksAll` returns all `pass` → `mergePr` proceeds to squash-merge (no exit)
- [x] 3.2 Add a test: fake `ghPrChecksRequired` returns the "no required checks" error AND `ghPrChecksAll` returns at least one `fail` → `mergePr` exits non-zero naming the failing check
- [x] 3.3 Add a test: fake `ghPrChecksRequired` returns the "no required checks" error AND `ghPrChecksAll` returns at least one `pending` → `mergePr` exits non-zero naming the pending check
- [x] 3.4 Confirm existing required-checks tests (required present + pass → proceed; required present + fail → block) still pass without modification
- [x] 3.5 Prove each new test bites: verify it fails before the fix is in place (comment confirming the red→green cycle)

## 4. Verify and finalize

- [x] 4.1 Run `npm run ci` from the repo root; confirm all tests pass
- [x] 4.2 Regenerate the plugin mirror: `node scripts/build.mjs`, commit updated `plugin/` together with `core/` changes
