# Tasks — recover-fix-harness-crash

## 1. Classification and budget primitives

- [x] 1.1 Add a pure `isFixHarnessCrash(result)` helper in `core/scripts/stages/fix.ts`:
      `success === false && timed_out !== true`. Export it for tests.
- [x] 1.2 Add a pure `remainingFixBudgetSec(fixTimeout, elapsedSec)` helper and a
      `MIN_RETRY_BUDGET_SEC` constant (60s); export both.
- [x] 1.3 Add a pure `shouldRetryFixHarness({ crash, attempt, maxRetries, remainingSec })` decision
      helper returning `{ retry: true, timeoutSec }` or `{ retry: false, reason }`.

## 2. Resumption preamble

- [x] 2.1 Add the resumption-preamble text (prompt-loader owned) instructing the harness that the
      listed paths are uncommitted in-progress work from a crashed attempt of this same fix round, to
      be reviewed and completed — never discarded, reset, restored, cleaned, or restarted.
- [x] 2.2 Add `buildFixResumptionPreamble(status, attempt)` returning `""` for a clean worktree and
      the preamble + changed-path list otherwise; the retry prompt is `preamble + basePrompt`.

## 3. Retry loop in `advanceFix`

- [x] 3.1 Introduce `FixCrashRecoveryDeps` (`now`, `worktreeStatus`, `invokeHarness`) and thread it
      through `AdvanceFixDeps` with real defaults.
- [x] 3.2 Wrap the fix-harness invocation in a bounded loop capped at `cfg.auto_recovery_max_retries`,
      using the helpers from §1; keep the delegated (external stage executor) result path unchanged.
- [x] 3.3 Pass the remaining-budget `timeoutSec` and the resumption prompt to each retry; keep model,
      effort, sandbox, env, and per-attempt cost accounting identical to the first attempt.
- [x] 3.4 Preserve the exhaustion path verbatim: `setBlocked(..., "harness-failure")` +
      `fixHarnessFailureOutcome(reason)`, with the reason naming the attempt count.
- [x] 3.5 Verify no destructive git call is introduced anywhere in the loop and the worktree is never
      removed.

## 4. Recording

- [x] 4.1 Add the additive `FixHarnessRecoveryEvent` (`type: "fix_harness_recovery"`) to the
      `RunEvent` union in `core/scripts/run-store.ts` and append it per attempt when `opts.runDir` is set.
- [x] 4.2 Append a `RecoveryRecord` with `trigger: "fix-harness-crash"` via `recordRecovery` when
      `opts.stateDir` is set; confirm the evidence-bundle summary renders it.

## 5. Tests

- [x] 5.1 Crash → one retry → success: asserts a second invocation happened and the run advanced.
- [x] 5.2 Crash on every attempt: asserts exactly `1 + auto_recovery_max_retries` invocations, then
      the unchanged `harness-failure` block with the attempt count in the reason.
- [x] 5.3 Timeout: asserts exactly one invocation and today's `timed out after Ns` block.
- [x] 5.4 Budget: asserts each retry's `timeoutSec` equals the remaining budget under a fake clock,
      and that a remaining budget below the floor blocks without invoking a retry.
- [x] 5.5 Dirty worktree: asserts the retry prompt contains the preamble, the changed paths, and the
      do-not-discard instruction; clean worktree: asserts the retry prompt is byte-identical to the
      first attempt's.
- [x] 5.6 Non-destructive: asserts the fake git seam saw no `reset`/`restore`/`checkout --`/`clean`
      and no worktree removal, and that the fake worktree status is unchanged across the retry.
- [x] 5.7 Recording: asserts one `fix_harness_recovery` event per attempt with the expected fields and
      one `fix-harness-crash` `RecoveryRecord` per attempt.
- [x] 5.8 `auto_recovery_max_retries: 0` reproduces today's single-shot behavior exactly.
- [x] 5.9 Prove the regression test bites (revert the loop → 5.1 fails).
- [x] 5.10 Add the preamble drift guard to `core/test/prompt-loader.test.ts`.

## 6. Ship

- [x] 6.1 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the same change.
- [x] 6.2 `npm run ci` green from the repo root.
- [x] 6.3 `openspec validate recover-fix-harness-crash` passes.
