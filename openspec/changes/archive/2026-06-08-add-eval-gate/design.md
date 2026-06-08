## Context

The pipeline is a label-driven state machine. Each stage is a `pipeline:<stage>` GitHub label; the orchestrator in `pipeline.ts` loops through a `dispatch()` switch that calls into a dedicated `stages/<stage>.ts` module. Configuration lives in `.github/pipeline.yml` (validated by `config.ts`); `PipelineConfig` carries the merged result. Existing extensibility patterns (`test_gate`, `steps`, `openspec`) all follow the same shape: a config block in `pipeline.yml` + a corresponding field on `PipelineConfig` + a stage module or inline handler.

Current terminal path: `pre-merge` → `ready-to-deploy` (finalized by `deployReady.finalize()`). The eval gate belongs between these two stages.

## Goals / Non-Goals

**Goals:**
- Insert an `eval-gate` stage between `pre-merge` and `ready-to-deploy` that is a no-op when `eval_gate` is not declared.
- Run the repo's eval command in the worktree; gate on exit code (0 = pass, non-zero = fail).
- Support gate (default) and advisory modes: gate blocks on fail; advisory records but never blocks.
- Time-bound the run: configurable timeout, bounded retries for transient failures.
- Record the outcome (pass/fail + stdout headline) as a comment on the issue/PR.
- Follow the existing `test_gate` pattern so the config schema, orchestrator dispatch, and stage module are structurally consistent.

**Non-Goals:**
- Auto-generating eval cases from spec deltas (separate issue, advisory-only when it lands).
- Deploy-time observability, canary rollout, auto-merge, or any post-deploy concern.
- Authoring or bundling a specific eval framework.

## Decisions

### D1: New pipeline stage (`eval-gate`) vs. sub-step inside `pre-merge`

**Decision**: New stage.

The `pre-merge` stage waits for CI, checks mergeability, and pushes docs — a distinct concern. Adding evals there conflates two independently useful gates and makes rollback harder. A dedicated `eval-gate` label in `STAGES` means it is visible in `--status`, pauseable, and debuggable in isolation, exactly like every other optional stage.

**Alternative considered**: run evals at the tail of `pre-merge`. Rejected: single-responsibility principle; `pre-merge` output is already long; a separate stage gives a clean blocked/retry surface.

### D2: Config shape follows `test_gate`

**Decision**: Add `eval_gate` block to `.github/pipeline.yml` and `PipelineConfig`, parallel to `test_gate`.

```yaml
eval_gate:
  enabled: true          # default false (opt-in)
  command: "pnpm evals"  # the eval harness command to run in the worktree
  mode: gate             # "gate" (default) | "advisory"
  timeout: 300           # seconds; default 300
  max_attempts: 2        # transient-error retries; default 2
```

When `enabled` is falsy or the block is absent, the `eval-gate` stage is skipped (same mechanism as disabled review stages in the orchestrator: the stage transitions forward with "step disabled" reason logged). The orchestrator does NOT add `eval-gate` to `STAGES` when the config is absent — it detects the skip at dispatch time to keep the label set small for repos that don't opt in.

**Alternative considered**: auto-detect a well-known file (e.g. `evals/`) instead of explicit config. Rejected: a discoverable file does not communicate the command, timeout, or mode; explicit config is unambiguous and is what all other pipeline features use.

### D3: Pass/fail owned entirely by the eval command's exit code

**Decision**: The pipeline treats exit 0 as pass and any non-zero exit as fail. The pipeline never interprets scores or thresholds — those belong in the repo's eval harness.

This matches `test_gate` and CI precedent. The eval author decides the threshold in their harness; the pipeline just reads the verdict.

### D4: Stage placement relative to the label list

**Decision**: `eval-gate` is inserted between `pre-merge` and `ready-to-deploy` in `STAGES`. Pre-merge ensures CI passes and the branch is mergeable before evals run (evals on a broken branch are noise).

### D5: Result comment format

**Decision**: Post a `## Eval Gate` comment on the issue. Include: mode, outcome (PASS/FAIL/ADVISORY), first 2000 chars of stdout/stderr, and elapsed time. On fail+gate, also call `setBlocked` (existing helper) with a summary. Pattern follows `## Review 1` / `## Review 2` comment headers.

### D6: Timeout and retry behaviour

**Decision**: A hard timeout terminates the child process and counts as a failure. On failure, the stage retries up to `max_attempts` times (transient tooling errors). After exhausting retries, the stage calls `setBlocked` with a "eval-gate timed out / errored" message. This prevents silent pass-through on infrastructure failures.

## Risks / Trade-offs

- **Non-deterministic evals block indefinitely**: if a model-judged eval is declared as `gate`, flaky results will re-block every pipeline run. Mitigation: the spec guidance says model-judged evals SHOULD be `advisory` until proven stable; the docs/proposal repeat this. The pipeline enforces nothing here — the maintainer owns the choice.
- **Worktree teardown race**: `deployReady.finalize()` removes the worktree after `ready-to-deploy`. Evals run in the worktree (they need the code). As long as `eval-gate` precedes `ready-to-deploy` in the stage order, the worktree is still present. This ordering is enforced by the `STAGES` constant.
- **Long eval runs hold the lock**: the pipeline mutex (lock.ts) is per-issue. A long eval run blocks concurrent invocations on the same issue. Mitigation: `timeout` is configurable; a reasonable default (300 s) caps the worst case.
- **stdout truncation**: capturing full harness output can be large. The comment truncates to 2000 chars (same cap as review raw output). The full output is not stored; this is an intentional trade-off for comment readability.

## Open Questions

- None: the issue decisions (gate vs advisory, harness owns pass/fail, no deploy observability) resolve the key design points. Config shape, stage placement, and exit-code semantics follow established repo patterns.
