# Tasks — fix-stage harness crash retry (#486)

## 1. Retry loop in the fix stage

- [ ] 1.1 Extract the current single harness invocation in `advanceFix` (`core/scripts/stages/fix.ts`)
      into an attempt function taking `{ attempt, timeoutSec, prompt }` and returning the harness
      result, preserving the existing `invokeStageExecutor` → `invoke` fallback and accounting args.
- [ ] 1.2 Wrap it in a bounded loop capped at `cfg.auto_recovery_max_retries` additional attempts;
      exit the loop on the first `result.success`.
- [ ] 1.3 Track wall-clock consumed per attempt and pass `max(0, fix_timeout − consumed)` as the next
      attempt's `timeoutSec`; add a named minimum-useful floor constant.
- [ ] 1.4 When remaining budget is at/below the floor, stop retrying and block with a
      budget-exhaustion reason and `blockerKind: "harness-failure"`.
- [ ] 1.5 Verify by inspection that no branch of the loop calls `removeWorktree`, `git reset`,
      `git clean`, `git checkout --`, or working-tree `git restore`.

## 2. Retry prompt

- [ ] 2.1 Add exported pure `buildFixRetryPreamble(attempt, limit, priorReason)` producing the
      addendum: prior attempt terminated abnormally, uncommitted work is present in the worktree,
      review and complete it rather than discarding or restarting.
- [ ] 2.2 Prepend the preamble only for attempts ≥ 2; keep attempt 1's prompt byte-identical.
- [ ] 2.3 Record the composed retry prompt via `recordPrompt` when `stateDir` is set.

## 3. Salvage on exhaustion

- [ ] 3.1 Before the terminal harness-failure block, call `trySalvageUncommittedWork` with
      `fixSalvageStageLabel(round, issueNumber)`.
- [ ] 3.2 On a salvaged commit, refresh `headAfter` and fall through to the existing downstream gate
      sequence (commit-message, OpenSpec delta, lockfile/build side effects, format/test).
- [ ] 3.3 On nothing salvaged, block exactly as today.

## 4. Observability

- [ ] 4.1 Add a `fix_harness_retry` variant to `RunEvent` in `core/scripts/run-store.ts` carrying
      `stage`, `attempt`, `limit`, `reason`.
- [ ] 4.2 Append one such event per retry attempt (best-effort, `.catch(() => {})`).
- [ ] 4.3 Record the retry attempts in the evidence bundle when `stateDir` is set.

## 5. Blocker worktree disclosure

- [ ] 5.1 Add exported pure `renderWorktreeStateSection(shortStatus)` → section markdown or `null`,
      with staged/unstaged/untracked counts and a bounded, deterministic file list.
- [ ] 5.2 Read `git status --short` via `gitInWorktree(..., { ignoreFailure: true })` and append the
      section to the reason for fix-stage `harness-failure` and `no-commits` blocks.
- [ ] 5.3 Omit the section on clean worktree or read failure; leave the outcome unchanged.

## 6. Single-turn prompt discipline

- [ ] 6.1 Add single-turn discipline text to `core/scripts/prompts/fix.md`.
- [ ] 6.2 Add the same discipline to `core/scripts/prompts/implementing.md`.
- [ ] 6.3 Add drift-guard assertions in `core/test/prompt-loader.test.ts`.

## 7. Tests

- [ ] 7.1 Crashing harness with `auto_recovery_max_retries: 2` → exactly 3 invocations, then blocked
      with `blockerKind: "harness-failure"`. Prove it bites by removing the loop.
- [ ] 7.2 Fail-then-succeed → no blocker, round transitions (`fix-1 → review-2`, `fix-2 → pre-merge`).
- [ ] 7.3 `auto_recovery_max_retries: 0` → exactly one invocation, pre-change reason and kind.
- [ ] 7.4 Budget: second attempt's `timeoutSec` is the residual, not `fix_timeout`; below-floor
      residual blocks without another invocation.
- [ ] 7.5 Retry prompt contains the addendum; attempt-1 prompt does not.
- [ ] 7.6 No destructive worktree/git seam call across an exhausted retry sequence.
- [ ] 7.7 Retry events present in the captured event stream with the expected fields; an event-write
      throw leaves the outcome unchanged.
- [ ] 7.8 Exhausted retries with a dirty worktree produce a salvage commit that still passes through
      the downstream gates; clean worktree blocks as today.
- [ ] 7.9 `renderWorktreeStateSection` unit tests: staged/unstaged/untracked counts, truncation,
      empty input → no section.
- [ ] 7.10 Structured-success-no-commit path unchanged (existing tests still green).

## 8. Ship gate

- [ ] 8.1 `cd core && npm test`.
- [ ] 8.2 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 8.3 `npm run ci` from the repo root green, including `openspec validate --all`.
