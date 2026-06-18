## 1. Verify gh field shapes

- [ ] 1.1 Run `gh pr view <any-ready-pr> --json mergeable,mergeStateStatus,statusCheckRollup,headRefName` on a live PR and document the exact field shapes (values, nested structure) in a code comment inside `merge.ts`.
- [ ] 1.2 Confirm that `gh pr merge <pr> --squash --delete-branch` exits 0 on a mergeable PR and document the output format (for parsing the merged commit SHA if needed).

## 2. Core merge handler (`core/scripts/stages/merge.ts`)

- [ ] 2.1 Define the `MergeDeps` interface: `ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>`, `ghPrMerge(pr: number): Promise<void>`, `getIssueLabels(issueNumber: number): Promise<string[]>`, `getPrLinkedIssue(pr: number): Promise<number | null>`.
- [ ] 2.2 Implement `realMergeDeps()` that wires each dep to the real `gh` subprocess (using the existing `gh.ts` helpers where applicable).
- [ ] 2.3 Implement the mergeability gate: read `mergeable` and `mergeStateStatus`; return an actionable refusal string for `CONFLICTING`, `DIRTY`, or `UNKNOWN`.
- [ ] 2.4 Implement the required-checks gate: parse `statusCheckRollup`; collect any checks that are failing, timed out, cancelled, or still in progress; return a refusal naming them.
- [ ] 2.5 Implement the issue-stage gate: call `getPrLinkedIssue` to find the linked issue number; inspect its labels for `pipeline:ready-to-deploy`; return a refusal if absent or if no linked issue is found.
- [ ] 2.6 Implement the merge execution: call `ghPrMerge`; treat "branch already deleted" as a non-fatal warning; print confirmation with PR number on success.
- [ ] 2.7 Export `mergePr(pr: number, deps: MergeDeps): Promise<void>` as the top-level entry point.

## 3. CLI dispatch (`core/scripts/pipeline.ts`)

- [ ] 3.1 Add `"merge"` to the recognized sub-commands list (near `"release"`, `"intake"`, `"sweep"`).
- [ ] 3.2 Add argument validation: `merge` requires exactly one positional argument that is a positive integer; exit non-zero with a usage error otherwise.
- [ ] 3.3 Add early dispatch block for `merge` (before the issue-advance path): resolve config, call `mergePr(prNumber, realMergeDeps())`, handle errors.
- [ ] 3.4 Update the help/usage string to include `merge <pr>` with a brief description.

## 4. Unit tests (`core/test/merge.test.ts`)

- [ ] 4.1 Write a test that stubs `MergeDeps` with a mergeable/clean/passing PR linked to a `ready-to-deploy` issue and asserts `mergePr` exits without error and calls `ghPrMerge` exactly once.
- [ ] 4.2 Write a test for the conflicted-PR refusal: `mergeable: "CONFLICTING"` → non-zero exit, no merge call.
- [ ] 4.3 Write a test for the dirty mergeStateStatus refusal: `mergeStateStatus: "DIRTY"` → non-zero exit, no merge call.
- [ ] 4.4 Write a test for the unknown mergeability refusal: `mergeable: "UNKNOWN"` → non-zero exit, no merge call.
- [ ] 4.5 Write a test for a failing required check: one check in `statusCheckRollup` with `conclusion: "FAILURE"` → non-zero exit naming the check, no merge call.
- [ ] 4.6 Write a test for a pending required check: one check still in progress → non-zero exit, no merge call.
- [ ] 4.7 Write a test for the wrong-issue-stage refusal: linked issue at `pipeline:review-2` → non-zero exit naming the current stage, no merge call.
- [ ] 4.8 Write a test for no linked issue: `getPrLinkedIssue` returns null → non-zero exit, no merge call.
- [ ] 4.9 Write the loop-isolation assertion test: import all stage handlers and the advance loop entry point; assert that none of their module dependency graphs reference any export from `merge.ts`.

## 5. Mirror regeneration and CI

- [ ] 5.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`; commit the updated mirror alongside the new `core/` files.
- [ ] 5.2 Run `npm run ci` from the repo root; fix any failures before marking the change done.
