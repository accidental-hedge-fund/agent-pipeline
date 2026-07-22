# Design — recover-fix-harness-crash

## Context

`advanceFix` (`core/scripts/stages/fix.ts`) invokes the fix harness once:

```ts
const result = delegated ?? await invoke(harness, wt.path, prompt, { timeoutSec: cfg.fix_timeout, ... });
if (!result.success) {
  const reason = result.timed_out ? `timed out after ${result.duration.toFixed(0)}s` : `exit ${result.exit_code}`;
  await setBlocked(cfg, issueNumber, `Fix harness (${harness}) failed: ${reason}`, stage, "harness-failure");
  return fixHarnessFailureOutcome(reason);
}
```

Everything downstream (`trySalvageUncommittedWork`, `decideExternalCommitAdvance`, the commit/format/
test gates) is reached only on `result.success`. So a crashed harness bypasses salvage entirely and
its in-progress worktree diff is abandoned to a human.

## Decisions

### D1 — Retry at the invocation site, not via `tryAutoRecover`

`tryAutoRecover` is implement-stage machinery: it removes the worktree (`removeWorktree`) and resets
labels to `pipeline:ready`. Reusing it for the fix stage would **destroy** exactly the uncommitted
work this change exists to preserve, and would rewind an issue that already has a PR under review.

The retry therefore lives inside `advanceFix` as a bounded loop around the single `invoke` call. The
existing block is kept verbatim as the loop's exhaustion path, so the failure contract for callers
(`blockerKind: "harness-failure"`, `reviewer-unavailable` intervention) is unchanged.

### D2 — Retry crashes, not timeouts

`invoke` distinguishes the two via `result.timed_out`. A timeout means the stage budget was actually
spent doing work; re-invoking would double the cost for the same wall-clock wedge and is the subject
of a separate issue (#398). Only `success === false && timed_out === false` — a process that died
early, the observed `exit 1` — is treated as a crash and retried. Fail closed: any result we cannot
classify as a crash takes today's immediate block.

### D3 — Budget is per-stage, not per-attempt

`cfg.fix_timeout` is the fix stage's wall-clock budget; retries must not multiply it. The loop tracks
elapsed wall-clock across attempts (injectable `now()`) and passes
`timeoutSec = fix_timeout - elapsed` to each retry. A floor (`MIN_RETRY_BUDGET_SEC`, 60s) prevents
spawning a harness that cannot plausibly finish; below the floor the loop stops and blocks with a
budget-exhaustion reason. This bounds worst-case fix-stage wall-clock at `fix_timeout` plus the
per-attempt process-teardown overhead, regardless of the retry cap.

### D4 — Cap reuses `auto_recovery_max_retries`

The issue asks for exactly this. No new config key (golden rule: don't grow the schema for a value
that already exists with the same meaning). `auto_recovery_max_retries` counts *additional* attempts:
`0` disables fix-crash retry and preserves today's behavior byte-for-byte.

### D5 — Resumption preamble, gated on a dirty worktree

The retry prompt is the same prompt string the first attempt used, prefixed with a preamble built
only when `git status --porcelain` in the worktree is non-empty. Keeping the base prompt identical
avoids duplicating the fix-round contract (commit subject, trailers, does-not-reproduce protocol),
which the gates downstream still enforce. Gating on dirtiness keeps a clean-worktree retry
byte-identical to the first attempt, so the retry is provably a plain re-run in that case.

The preamble states: a previous attempt of this same fix round crashed; the listed paths are its
uncommitted in-progress work; review it, correct what is wrong, complete it, and commit — do not
discard it, do not `git checkout`/`git restore`/`git clean` it, and do not restart from scratch.

### D6 — The recovery path never cleans

No destructive git call is added anywhere in the loop, and the worktree is not removed. This is
asserted by a test that fails if the recovery path ever invokes a `reset`/`restore`/`checkout --`/
`clean` git subcommand. It is the load-bearing safety property of the change: the whole point is that
the draft survives the crash.

### D7 — Recording: event + evidence record

Two records per attempt, matching how the pipeline already reports recoveries:

- `events.jsonl`: an additive `fix_harness_recovery` event (`stage`, `attempt`, `max_attempts`,
  `exit_code`, `remaining_budget_sec`, `worktree_dirty`), a new member of the `RunEvent` union. It is
  not a `stage_start`/`stage_complete` event, so stage-timeline consumers are unaffected.
- Evidence bundle: `recordRecovery(stateDir, issue, { trigger: "fix-harness-crash", round, at })`,
  reusing the existing `RecoveryRecord` shape and its summary renderer.

Both are best-effort and gated on `opts.runDir` / `opts.stateDir` respectively, matching the existing
convention that unit tests produce no filesystem side effects.

### D8 — Test seam

A `FixCrashRecoveryDeps` interface (`now`, `worktreeStatus`, and the harness `invoke`) is threaded
through `AdvanceFixDeps`, following `AdvanceReviewDeps`/`SalvageDeps`. Unit tests drive the loop with
a scripted sequence of fake harness results and a fake clock — no real subprocess, git, or network.

## Risks / trade-offs

- **Doubled spend on a deterministically-crashing harness.** Bounded by the cap *and* by the shared
  stage budget (D3), so the ceiling is one stage budget rather than `N ×` it.
- **A retry might redo work the crashed attempt already committed.** Not a new risk: the retry runs
  in the same worktree at the same HEAD, and the existing commit gates and salvage path still run
  after the last attempt exactly as before.
- **Prompt drift.** The preamble is a prompt-loader-owned string, drift-guarded by a test in
  `prompt-loader.test.ts` like the surgical-fix disciplines.

## Alternatives considered

- *Retry unconditionally, including timeouts* — rejected: doubles cost on wedges and overlaps #398.
- *Full `fix_timeout` per retry* — rejected: unbounded stage wall-clock; an operator's timeout config
  would silently mean `N × fix_timeout`.
- *Salvage-commit-then-block on crash* — rejected: it converts a half-finished draft into a committed
  PR change without ever completing it, and would push an untested diff through the gates. Preserving
  and resuming the draft is strictly better.
