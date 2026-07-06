# Design — eval-gate-fix-round

## Context

- The **test gate** (`core/scripts/testgate.ts`, `runTestGate`) is the model: on a failing
  test/build run it invokes the implementer harness with a fix prompt (`buildTestFixPrompt`, which
  injects the failing command + captured output), verifies the fix committed, re-runs the command,
  and loops up to `test_gate.max_attempts` fix-harness invocations before blocking. It runs *inline*
  within a stage — it is not itself a state-machine stage.
- The **eval gate** (`core/scripts/stages/eval.ts`, `advanceEval`) currently runs the eval command
  in a loop bounded by `eval_gate.max_attempts` (each attempt re-runs the *same* command with no fix
  between runs), then: passes → advance; gate-mode ordinary fail → `setBlocked` (`eval-gate-failed`);
  advisory fail → advance; timeout/spawn error → `setBlocked` (`harness-failure`) regardless of mode.
- The eval gate runs **after** pre-merge, immediately before `ready-to-deploy` (or `shipcheck-gate`).

## Decisions

### D1 — Inline fix loop, not a new stage

Mirror the test gate: the fix loop lives inside `advanceEval`. Each gate-mode ordinary failure that
has budget remaining invokes the implementer harness, commits+pushes, and re-runs the eval command,
all within the single `eval-gate` stage. This keeps the state machine unchanged (no new stage/label,
no `STAGES` edit) and reuses the exact recovery shape the test gate already ships. The alternative —
a dedicated `eval-fix` stage with transitions back to `eval-gate` — adds state-machine surface for
no behavioral benefit and is rejected.

### D2 — Config: reuse `eval_gate.max_attempts` (the `fix.max_attempts` naming conflict)

The issue's acceptance criteria name **`fix.max_attempts`**. **No such config key exists** — the
config schema (`core/scripts/config.ts`, `core/scripts/types.ts`) has `test_gate.max_attempts`
("max fix-harness invocations before blocking"), `eval_gate.max_attempts` ("total attempts; 1 = no
retry"), and `fix_timeout` (per-fix-invocation timeout). There is no `fix` config block.

Honoring the stated intent — *reuse an existing fix-round budget, do not add a separate counter* —
the eval fix-round budget reuses **`eval_gate.max_attempts`**. Its meaning is preserved as "total
eval command runs"; the only change is that in gate mode each run after the first is now preceded by
one fix round. So `max_attempts` bounds both the total eval runs and (therefore) the fix rounds
(`fix rounds = runs − 1` in gate mode). `max_attempts: 1` → no fix round, block on the first
failure. This keeps the eval gate's own tuning co-located and makes it behave like the test gate,
whose `max_attempts` is likewise the fix-loop budget.

The rejected alternative — reusing `test_gate.max_attempts` for the eval loop (a literal reading of
"the fix loop's max_attempts") — cross-wires two independent gates' budgets and is surprising to an
operator tuning one gate. Surfacing this here rather than silently inventing a `fix.max_attempts`
key follows the repo's "verify external shapes; never guess" and "surface conflicts with sources"
rules.

### D3 — The existing "transient retry" semantics are replaced by fix rounds

Today an eval retry re-runs the same command with no intervening change (a flaky-harness cushion).
Making the gate "behave consistently with the test gate" (which has no plain retry — every re-run is
preceded by a fix) means each gate-mode retry is now preceded by a fix round. Flaky-specific retry
handling is explicitly out of scope for this change (per the issue), so no separate no-fix retry is
retained; a gate-mode failure is treated as a code regression and fixed, exactly as the test gate
treats a failing test.

### D4 — Which failures route to a fix round

Only an **ordinary non-zero exit in gate mode** routes to a fix round. Specifically excluded:

- **Advisory mode** — records the comment and advances; never fixes (out of scope; unchanged).
- **Timeout** (`timedOut`) and **spawn/runner error** (`spawnError`) — these mean the eval harness
  could not run, not that the code regressed. They block immediately (`harness-failure`) regardless
  of mode and never fix. This preserves the existing tooling-failure invariant in `eval.ts`.

### D5 — Eval-fix context injected into the fix prompt

The fix prompt receives the eval output as an explicit context field naming the gate ("eval-gate"),
the command string (`cfg.eval_gate.command`), and the bounded combined stdout/stderr. Two viable
implementations (left to the implementation step, both satisfy the spec):

1. Extend `buildFixPrompt` / `fix.md` with an optional eval-context field (the issue's named
   integration point), or
2. Add an eval-specific fix prompt paralleling `buildTestFixPrompt` / `test_fix.md`.

Whichever is chosen, the surgical-fix / destructive-op-guard / pre-commit-self-check disciplines and
the `Issue:`/`Pipeline-Run:` traceability trailers apply to the eval-fix commit, consistent with
every other fix path. Output is bounded (reuse the stage's existing `truncate` tail-biased elision so
the pass/fail summary survives).

### D6 — Eval-fix failure handling and no partial push

The eval-fix round reuses the fix/test-gate failure contract: a harness error, timeout, no new
commit produced (after salvage), a worktree left dirty, or a failed push blocks the item
(`harness-failure` for harness/commit problems, `push-failed` for a failed push) and never pushes a
partial fix. The eval command is only re-run after a verified, pushed fix commit.

### D7 — Rigor note: the eval-fix commit lands after pre-merge review

The eval gate runs after pre-merge, so an eval-fix commit is a developer commit that reaches
`ready-to-deploy` without a pipeline review round (unlike a test-gate fix, which lands before review
completes). This is acceptable under the pipeline's contract because **the pipeline never merges** —
it stops at `ready-to-deploy` and a human owns the merge button, and that human sees the eval-fix
commit on the PR. A future change may route the eval-fix commit back through the pre-merge delta
re-review (as `pre-merge-fix-round` does) for parity; that is out of scope here and noted as an open
follow-up.

## Timeouts

Eval command runs remain bounded by `eval_gate.timeout` (the existing stage budget). Each eval-fix
harness invocation is bounded by `fix_timeout`, exactly as the test gate bounds its fix invocations.
The stage-level eval deadline continues to bound the eval *runs*; fix-harness time is accounted
separately (its own `fix_timeout`).

## Testing

All new behavior is exercised through the existing dependency-injection seams (`EvalDeps` plus an
injectable harness invoker), so unit tests do no real harness, git, or network I/O — matching
`AdvanceReviewDeps` / `TestGateDeps` conventions. Tests prove they bite by failing when the
fix-routing branch is reverted to the current immediate-block behavior.
