## 1. Eval-fix prompt context

- [x] 1.1 Add an injectable eval-output context field to the fix prompt (either extend
  `buildFixPrompt`/`fix.md` with an optional eval-context section, or add a dedicated eval-fix
  prompt paralleling `buildTestFixPrompt`/`test_fix.md`). The rendered context SHALL name the gate
  (`eval-gate`), the command (`cfg.eval_gate.command`), and the bounded combined stdout/stderr.
- [x] 1.2 Bound the injected output with the stage's existing tail-biased `truncate` so the pass/fail
  summary survives elision; keep the non-eval fix prompt rendering byte-for-byte unchanged when no
  eval context is supplied (drift-guard test in `prompt-loader.test.ts` if `fix.md` is touched).

## 2. Eval-fix loop in `advanceEval`

- [x] 2.1 Add an injectable harness invoker seam to `EvalDeps` (default `invoke` from `harness.ts`),
  plus the git/worktree seams needed to commit + push + read HEAD (mirror `TestGateDeps` /
  `AdvanceFixDeps`), so the loop is unit-testable with no real harness/git/network.
- [x] 2.2 Restructure the attempt loop: on a run result, branch — passed → advance; `timedOut` or
  `spawnError` → block immediately (`harness-failure`), no fix round; advisory-mode ordinary fail →
  advance (record comment), no fix round; gate-mode ordinary fail with a remaining attempt → run a
  fix round; gate-mode ordinary fail on the last attempt → fall through to the terminal block.
- [x] 2.3 Fix round: build the eval-fix prompt (task 1), invoke the implementer harness in the
  worktree with `cfg.fix_timeout` / `cfg.models.fix` / `cfg.harness_sandbox`, capture HEAD before,
  and record the prompt/accounting the way `advanceFix` does when `stateDir`/`runDir` are set.
- [x] 2.4 Post-fix verification (reuse the fix/test-gate contract): salvage uncommitted work; block
  (`harness-failure`) on harness error, no new commit produced, or a worktree left dirty; verify the
  fix commit carries `Issue:`/`Pipeline-Run:` trailers; then `git push` and block (`push-failed`) on
  push failure. Never push a partial fix.
- [x] 2.5 After a verified pushed fix, loop to re-run the eval command against the updated code.

## 3. Terminal + unchanged paths

- [x] 3.1 Keep the terminal gate-mode block unchanged: after the budget is exhausted, `setBlocked`
  with the final eval output (tail-biased excerpt) and blocker kind `eval-gate-failed`.
- [x] 3.2 Keep advisory-mode fail (advance + comment), timeout/spawn-error block, the disabled/skip
  path, the misconfigured (`command` unset) block, and the missing-worktree block exactly as today.
- [x] 3.3 Record the eval-result comment and the `gate_result` run-store event on every terminal
  outcome as today (pass / advisory-fail / gate-fail-exhausted / tooling-fail).

## 4. Tests (DI seams only — no real harness/git/network)

- [x] 4.1 Gate-mode fail → fix round invoked → re-run passes → routes to `pre-merge` for review
  (not directly to the configured next stage); assert the harness seam was called once and the eval
  command re-ran.
- [x] 4.10 (#372 review 1, finding 1) A pass with no preceding fix round in the current invocation
  still advances directly to the configured next stage, unaffected by 4.1's routing change.
- [x] 4.11 (#372 review 2, finding 1) A pass with no fix round in the current invocation, but an
  unreviewed eval-fix commit already on the PR from an earlier, interrupted invocation, still routes
  to `pre-merge` — proving the routing decision is derived from durable GitHub PR state, not an
  in-memory flag. A GitHub lookup failure during that derivation fails closed to `pre-merge`.
- [x] 4.2 Gate-mode fail → fix rounds exhausted (`max_attempts` reached) → `setBlocked`
  (`eval-gate-failed`) with the final eval output surfaced.
- [x] 4.3 Advisory-mode fail → advances, harness seam NOT called (no fix round).
- [x] 4.4 Timeout and spawn-error → block immediately (`harness-failure`), harness seam NOT called,
  in both gate and advisory mode.
- [x] 4.5 `max_attempts: 1` → no fix round; first gate-mode failure blocks.
- [x] 4.6 Eval-fix failure paths → block without a partial push: (a) harness error, (b) no new
  commit produced, (c) dirty worktree after fix, (d) push failure (`push-failed`).
- [x] 4.7 Disabled / absent `eval_gate` → skip path unchanged (no harness, no comment).
- [x] 4.8 The fix prompt embeds the eval-gate context (gate name, command, bounded output).
- [x] 4.9 Prove the tests bite: with the fix-routing branch reverted to immediate `setBlocked`, 4.1
  and 4.2 fail; restore.

## 5. Mirror + CI

- [x] 5.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror in the same change.
- [x] 5.2 `npm run ci` green end-to-end (core tests + `build.mjs --check` + install smoke +
  `openspec validate --all`).
