# Design — fix-stage harness crash retry (#486)

## Context

`advanceFix` (`core/scripts/stages/fix.ts`) invokes the implementer harness once, either through
`invokeStageExecutor` (external executor) or `invoke` (local CLI). On `!result.success` it calls
`setBlocked(..., "harness-failure")` and returns `fixHarnessFailureOutcome(reason)` — no retry, no
salvage. The loop-level `tryAutoRecover` only fires for `stage === "implementing"` and removes the
worktree, so it is both unreachable and inappropriate here.

## Decisions

### D1 — Retry inside the stage, not in the run loop

The loop-level recovery works by resetting labels and destroying the worktree; a fix round's value
is precisely the worktree contents. Retrying inside `advanceFix` keeps the worktree, the round's
review findings, `headBefore`, and the accounting context in scope, and requires no state-machine
change. **Chosen.** Alternative (extend `tryAutoRecover` to fix stages) was rejected: it would have
to grow a "don't remove the worktree" mode and re-derive the round's review context from labels.

### D2 — Reuse `auto_recovery_max_retries`, add no config key

The issue names this key explicitly and the semantics match ("how many times may the pipeline retry
a failed attempt"). A separate `fix_retry_max` would be one more knob describing the same operator
intent. **Chosen:** the same key caps both paths.

### D3 — Budget accounting is wall-clock subtraction against `fix_timeout`

`fix_timeout` is the stage's budget, not the attempt's. Retrying with the full `fix_timeout` would
let a crash loop consume `(cap+1) × fix_timeout`. Each attempt records its wall-clock duration
(available as `result.duration`, with a monotonic fallback around the invocation); the next
attempt's `timeoutSec` is `max(0, fix_timeout − consumed)`. A minimum-useful floor prevents starting
an attempt that cannot plausibly finish; below it, the stage blocks with a budget-exhaustion reason.
The floor is a named constant in the stage module, not a config key.

### D4 — The retry addendum is a prompt prefix, not a new template

`buildFixPrompt` output is unchanged for attempt 1 — important because the fix prompt is
drift-guarded and evidence-recorded. The addendum is prepended for attempts ≥ 2 by a small exported
pure function (`buildFixRetryPreamble(attempt, limit, priorReason)`), which keeps the addendum
unit-testable and the base prompt byte-identical on the first attempt. The prompt recorded to the
evidence bundle for a retry is the composed prompt actually sent.

The addendum deliberately does **not** describe the worktree diff in detail; it points the harness
at the worktree and instructs it to inspect its own uncommitted state. Reproducing a diff into the
prompt would be large, stale-prone, and duplicative of what the harness can read.

### D5 — Salvage runs after exhaustion, reusing #131

`trySalvageUncommittedWork` already exists, already excludes `node_modules`, already carries the
traceability trailers, and already routes salvaged commits through the full downstream gate
sequence. The crash path simply gains the call it never had, using the same
`fixSalvageStageLabel(round, issueNumber)` label the success path uses, so the salvage commit
satisfies `enforceFixCommitGate`. No change to the salvage module's behavior is required.

Ordering matters: salvage runs **after** the last retry, not between retries. Committing between
attempts would hand the next attempt a committed diff and defeat the "review and complete your own
in-progress work" instruction, and would create partial commits that the round's gates then judge.

### D6 — Worktree disclosure is a pure renderer over `git status --short`

A `renderWorktreeStateSection(shortStatus)` pure function returns the markdown section or `null`
when clean, keeping the reason-string assembly testable without git. The stage reads the status via
the existing `gitInWorktree(..., { ignoreFailure: true })` pattern, so a failed read degrades to
omitting the section. The section is appended to the blocker *reason* passed to `setBlocked`, which
avoids touching `gh.ts`'s attested-comment renderer or the `PIPELINE_COMMENT_KINDS` drift guard.

### D7 — New `RunEvent` variant rather than overloading `stage_complete`

A dedicated `fix_harness_retry` event keeps `stage_complete` semantics ("the stage finished") intact
and gives log consumers an unambiguous retry signal carrying `stage`, `attempt`, `limit`, and
`reason`. Appends are best-effort (`.catch(() => {})`) like the surrounding event calls.

### D8 — Single-turn prompt discipline is additive text, drift-guarded

The human comment's root cause (agent defers commit to a background-task notification that never
arrives in a one-shot invocation) is a prompt-contract gap, not a retry gap. It is fixed where it
originates, in `fix.md` / `implementing.md`, and pinned by a `prompt-loader.test.ts` assertion in
the same style as the existing surgical-fix guards.

## Risks

- **Crash-loop cost.** A harness that crashes fast could burn `cap+1` invocations. Mitigated by D3
  (shared budget) — total wall clock stays bounded by `fix_timeout`; token cost is bounded by the
  cap, which the operator already controls.
- **Retrying a deterministic failure.** If the crash is caused by the prompt or repo state, retries
  add cost without progress. Accepted: the cap is small (default 2) and the terminal block is
  unchanged, so the worst case is the current behavior plus bounded retries.
- **Double-work.** A retry might redo work the crashed attempt already did. Mitigated by D4's
  instruction to inspect and complete existing uncommitted changes.

## Non-goals

- Review-stage harness hangs (#398) and reviewer spawn crashes (#393) — explicitly out of scope.
- Any change to the implementing-stage `tryAutoRecover` behavior.
- Any auto-merge or stage-skipping behavior.
