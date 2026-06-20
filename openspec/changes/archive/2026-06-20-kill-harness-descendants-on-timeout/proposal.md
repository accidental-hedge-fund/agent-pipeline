## Why

When a harness invocation times out, the pipeline kills the parent process but orphans any child processes it spawned (e.g., a sub-agent or background shell command). Those orphans continue consuming resources and can interfere with subsequent pipeline runs. The `runCapped` function already supports process-group killing via a `killProcessGroup` option, but `invoke()` never passes it.

## What Changes

- `core/scripts/harness.ts`: `invoke()` sets `killProcessGroup: true` in the `runCapped` call so that on timeout, the full descendant process tree (not just the direct child) is sent SIGTERM then SIGKILL.
- The change is unconditional for all harness types (`claude`, `codex`, and custom reviewer CLIs) — the spawned child process is always detached into a new process group, which changes nothing about normal (non-timeout) behavior and costs nothing at runtime.
- A regression test spawns a child that itself spawns a grandchild sleeping well past the timeout, then asserts both processes are absent after the timeout fires.

## Capabilities

### New Capabilities
- `harness-descendant-cleanup`: On harness timeout, the pipeline SHALL kill the entire descendant process tree rooted at the spawned harness process, not just the direct child.

### Modified Capabilities
None.

## Impact

- `core/scripts/harness.ts` (the `invoke` function and its call to `runCapped`).
- `core/test/harness.test.ts` (new regression test asserting grandchild termination).
- No changes to the state machine, stages, prompts, or plugin mirror beyond the harness module.

## Acceptance Criteria

- [ ] After a timed-out harness invocation, no descendant processes (grandchildren or deeper) of the original harness command remain alive.
- [ ] Existing harness timeout behavior (SIGTERM → 5 s grace → SIGKILL) is preserved and the `timed_out: true` flag is still set in the returned `HarnessResult`.
- [ ] Existing stderr capture and streaming behavior is unchanged — captured output accumulated before timeout is still returned.
- [ ] A new unit test spawns a grandchild that sleeps past the timeout and asserts both the direct child and grandchild are gone after the pipeline timeout fires.
- [ ] `npm run ci` passes (core tests green, mirror in sync).
