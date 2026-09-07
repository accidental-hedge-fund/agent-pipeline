## Why

A nested whole-item advance can exit nonzero while leaving its issue at the same stage. The loop dispatcher currently discards the child exit code and signal, and the supervisor then replaces the failure with a generic diagnostic, causing slow and irrelevant recovery attempts with no actionable evidence.

## What Changes

- Preserve a nested advance child's exit code or signal in a structured stage diagnostic when authoritative issue/run evidence does not establish another terminal outcome.
- Preserve a valid recoverable diagnostic supplied by a failed loop-execution response instead of replacing it at the supervisor boundary.
- Route a structured nested-child process exit directly to workflow-engine restart recovery, excluding product/scratch/publication repair recipes.
- Add regression coverage for the producer, transport, and recovery-selection seams.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `durable-loop-supervisor`: Preserve nested child process termination evidence across dispatch and supervisor recovery boundaries.
- `durable-blocker-classification`: Select process-restart recovery from structured nested-child exit evidence without invoking unrelated repair recipes.

## Impact

Affected code is limited to loop dispatch, stage-diagnostic transport, durable supervisor failure handling, and diagnostic-scoped recovery selection. The `pipeline/loop-execution@1` response remains backward compatible because the diagnostic is already optional and the new detail member is additive.
