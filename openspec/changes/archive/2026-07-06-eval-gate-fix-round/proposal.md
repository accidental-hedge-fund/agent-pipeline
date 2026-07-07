## Why

When the test/build gate fails, the pipeline does not stop — it routes the failure back through a
bounded fix loop with the failing command's output injected as context (`runTestGate` in
`testgate.ts`), and only blocks once the fix budget is exhausted. The eval gate (`eval.ts`) was
built as a standalone gate with no equivalent recovery path: on a gate-mode failure it calls
`setBlocked` immediately. The operator must then manually unblock, and the human-driven fix round
runs blind — it has no signal that evals failed, which gate failed, what the command was, or what it
produced.

This makes the eval gate a trip wire rather than a recoverable gate, and it is inconsistent with how
the test gate — the eval gate's structural sibling — already behaves. This change makes the eval
gate route a genuine gate-mode failure into a fix round with the eval output as explicit context,
re-run the eval against the fixed code, and block (with the final eval output surfaced) only after
the fix budget is exhausted.

## What Changes

- When the eval gate fails in **gate mode** with an ordinary non-zero exit (a code regression, not a
  tooling failure) and fix budget remains, the stage SHALL invoke the implementer harness with the
  eval output as explicit context instead of blocking. The harness commits and pushes the fix, and
  the eval command is re-run against the updated code.
- The fix prompt SHALL receive the eval-gate output (combined stdout + stderr, bounded to a
  reasonable size) as an explicit context field identifying which gate failed, the command that ran,
  and what it produced — so the harness is not fixing blind.
- The fix-round budget SHALL reuse the existing `eval_gate.max_attempts` counter, not a new config
  key: each eval attempt after the first is preceded by one fix round in gate mode, so
  `max_attempts` bounds the total eval runs (and therefore the fix rounds) exactly as it bounds
  total eval runs today. `max_attempts: 1` means no fix round (block on the first failure).
- If the eval passes after a fix round, the stage advances normally (to `shipcheck-gate` or
  `ready-to-deploy`, per config).
- If the eval still fails after the fix budget is exhausted, the stage blocks with the final eval
  output surfaced — the same terminal blocking behavior as today.
- **Advisory mode is unchanged**: an advisory-mode eval failure records the result comment and
  advances, and SHALL NOT route to a fix round.
- **Tooling failures are unchanged**: a timeout or a spawn/runner error blocks immediately regardless
  of mode and SHALL NOT route to a fix round — these indicate the eval harness itself could not run,
  not that the code regressed.
- An eval-fix round that fails (harness error, no commit produced, a worktree left dirty, or a push
  failure) blocks the item (harness-failure / push-failed) and SHALL NOT push a partial fix — the
  same failure handling the fix stage and test gate already use.
- Repos with the eval gate disabled (or absent) are completely unaffected.

## Capabilities

### Added Capabilities

- `eval-gate-fix-round`: bounded routing of a gate-mode eval failure into an implementer fix round
  with the eval output as context, re-running the eval against the fixed code and blocking only once
  the `eval_gate.max_attempts` budget is exhausted.

### Modified Capabilities

- `eval-gate`: the "gate mode blocks on fail" behavior SHALL first route an ordinary (non-tooling)
  gate-mode failure through the `eval-gate-fix-round` loop; it blocks only after the fix budget is
  exhausted. The "transient-error retry" behavior SHALL become the fix-round loop: each retry after
  the first failure is preceded by a fix round in gate mode.

## Acceptance Criteria

- [ ] When the eval gate fails in gate mode with an ordinary non-zero exit and fix attempts remain,
  the stage invokes the implementer harness (a fix round) rather than calling `setBlocked`
  immediately.
- [ ] The fix prompt receives the eval-gate output (combined stdout + stderr, bounded to a reasonable
  size limit) as an explicit context field that identifies the failed gate, the command string, and
  the produced output.
- [ ] After the fix round commits and pushes, the eval command is re-run against the updated worktree
  code.
- [ ] If the re-run eval passes, the item advances to the configured next stage (`shipcheck-gate`
  when opted in, else `ready-to-deploy`) — the same advance path as a first-try pass.
- [ ] If the eval still fails after `eval_gate.max_attempts` is exhausted, the stage calls
  `setBlocked` with the final eval output surfaced and blocker kind `eval-gate-failed` — the same
  terminal behavior as today.
- [ ] In advisory mode, an eval failure records the result comment and advances, and never invokes a
  fix round — advisory-mode behavior is byte-for-byte unchanged.
- [ ] A timeout or spawn/runner error blocks immediately with blocker kind `harness-failure`,
  regardless of mode, and never invokes a fix round.
- [ ] The fix-round budget is governed by the existing `eval_gate.max_attempts` config; no new config
  key is introduced. `max_attempts: 1` performs no fix round and blocks on the first gate-mode
  failure.
- [ ] An eval-fix round whose harness errors, produces no new commit, leaves the worktree dirty, or
  whose push fails blocks the item (harness-failure / push-failed) without pushing a partial fix.
- [ ] With the eval gate disabled (or the `eval_gate` block absent), pipeline behavior is unchanged —
  the stage skips and the item advances with no eval comment.
- [ ] Regression tests (dependency-injection seams only — no real harness, git, or network) cover:
  (a) gate-mode fail → fix round → re-run passes → advances; (b) gate-mode fail → fix rounds
  exhausted → blocks with final output; (c) advisory-mode fail → advances, no fix round; (d) timeout
  and spawn error → block immediately, no fix round; (e) `max_attempts: 1` → no fix round; (f) an
  eval-fix harness failure → block, no partial push. Each test bites without the change.
- [ ] `npm run ci` passes end-to-end (core tests + `build.mjs --check` mirror + install smoke +
  `openspec validate --all`).
