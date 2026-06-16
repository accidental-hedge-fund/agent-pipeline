## 1. Extract shared post-implementation helper

- [ ] 1.1 In `core/scripts/stages/planning.ts`, extract the gate+push+PR+transition block from `advance()` (lines ~282–354) into a new exported async function `resumeFromImplementing(cfg, issueNumber, wt, opts)`. The function SHALL accept the existing worktree (`wt`) and AdvanceOpts, run the test gate, push, create-or-find-PR, and transition `implementing → review-1`.
- [ ] 1.2 Do the same for the equivalent block in `advanceOpenspec()` (lines ~666–720), or pass a `prBody` parameter so a single helper covers both flows.
- [ ] 1.3 Replace the inline blocks in `advance()` and `advanceOpenspec()` with calls to the extracted helper to remove duplication.

## 2. Dispatch resume path

- [ ] 2.1 In `core/scripts/pipeline.ts`, change the `implementing` dispatch case from the unconditional "waiting" return to:
  - Call `getForIssue(cfg, issueNumber)` to look for an existing worktree.
  - If a worktree exists AND `hasCommitsAhead(wt.path, cfg.base_branch)` is true, call the new `planning.dispatchResume(cfg, issueNumber, opts)` function and return its outcome.
  - Otherwise return the existing `{ advanced: false, status: "waiting", reason: "..." }` response.
- [ ] 2.2 Export a `dispatchResume(cfg, issueNumber, opts)` function from `planning.ts` that wraps `getForIssue` + `resumeFromImplementing()`, suitable for the dispatch call site.

## 3. Tests

- [ ] 3.1 Unit test (dispatch path): inject a fake worktree + fake `hasCommitsAhead=true` → `dispatch("implementing", ...)` returns `{ advanced: true, to: "review-1" }`.
- [ ] 3.2 Unit test (dispatch path): inject no worktree OR `hasCommitsAhead=false` → `dispatch("implementing", ...)` returns `{ advanced: false, status: "waiting" }` (no regression).
- [ ] 3.3 Unit test (`resumeFromImplementing`): gate passes, push succeeds, no existing PR → creates PR and returns `{ advanced: true, from: "implementing", to: "review-1" }`.
- [ ] 3.4 Unit test (`resumeFromImplementing`): gate passes, push succeeds, PR already exists → reuses the existing PR number and returns `{ advanced: true }`.
- [ ] 3.5 Unit test (`resumeFromImplementing`): gate fails → calls `setBlocked` and returns `{ advanced: false, status: "blocked" }`.
- [ ] 3.6 Prove each test bites (it fails without the corresponding implementation change).

## 4. Mirror + CI

- [ ] 4.1 Run `node scripts/build.mjs` to regenerate `plugin/` mirror.
- [ ] 4.2 Run `npm run ci` from repo root; all checks green.
