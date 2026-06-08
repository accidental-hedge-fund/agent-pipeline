## Why

The pipeline produces a `ready-to-deploy` label after unit tests, CI, and code review, but there is no behavioral quality gate — unit tests can pass while model-level regressions silently slip through. When a repo declares its own eval suite, the pipeline should run those evals automatically and record the result so the person merging gets an explicit, machine-decided quality signal without any per-issue configuration.

## What Changes

- **Eval-gate step** added after the review/fix stages and before `ready-to-deploy`: detects a per-repo eval declaration, runs the eval harness, and routes on outcome.
- **Gate mode (default)**: on pass → advance to `ready-to-deploy`; on fail → label `blocked`, record failing results on the issue/PR, halt progression.
- **Advisory mode**: results are recorded on the issue/PR but never block progression; the item proceeds to `ready-to-deploy` regardless of outcome.
- **Declared once, auto-detected every run**: a single per-repo opt-in (config entry or conventional file); no per-issue human input required.
- **Time-bounded with surfaced failures**: the step has a hard timeout; transient tooling errors are retried within the limit; genuine timeouts or harness errors surface as a `blocked` label rather than silent pass.
- **No-op for repos with no evals**: repos that declare no evals are completely unaffected — the step is skipped and the pipeline behaves exactly as today.

## Capabilities

### New Capabilities

- `eval-gate`: The autonomous eval-gate step — discovery of a repo's eval declaration, harness invocation, outcome routing (gate vs advisory), result recording on issue/PR, timeout/retry policy, and no-op behavior when no declaration is present.

### Modified Capabilities

(none — no existing spec-level requirements change; pipeline stage ordering and label-transition logic are implementation-level additions)

## Impact

- `core/scripts/stages/` — new `eval.ts` stage module
- `core/scripts/pipeline.ts` (or equivalent orchestrator) — inserts eval step between review/fix and `ready-to-deploy` transition
- Pipeline PR/issue comments — new eval result comment format (pass/fail + headline metrics)
- Repo config convention — new optional `evals` declaration key in `.pipeline.yaml` (or equivalent)
- Pipeline labels — `blocked` label used when eval gate fails (already exists for review failures)
