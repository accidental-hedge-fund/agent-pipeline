## Why

Today there is no programmatic way to move an issue between `pipeline:backlog` and `pipeline:ready` — it requires manual `gh issue edit`, done by hand. The pipeline-desk stage chip is read-only and cannot set stage labels either. Both the CLI and the desk need one authoritative command that encodes the pre-pipeline transition rules, so the rules live in exactly one place.

## What Changes

- Add `triage` as a new positional sub-command keyword accepted by the pipeline CLI, taking an issue number and a `--stage ready|backlog` flag.
- Add `core/scripts/stages/triage.ts` implementing the handler with injectable I/O deps (same seam pattern as `release.ts`).
- The handler sets exactly one `pipeline:<stage>` label on the target issue and removes any other `pipeline:*` stage label; re-running is idempotent.
- Only the two pre-pipeline stages (`backlog`, `ready`) are settable via `triage`; attempting a mid-flight stage (`planning`, `review-2`, etc.) is rejected with a clear error — those are owned by the advance state machine.
- No model harness call; the command is fully deterministic.

## Capabilities

### New Capabilities
- `triage-sub-command`: The `triage` sub-command: CLI dispatch, pre-pipeline stage validation, idempotent label set/swap, injectable-deps seam, and unit tests.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `triage` as a recognized keyword with an issue-number argument; it MUST be listed in the CLI help text alongside other sub-commands.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definition (`--stage`).
- `core/scripts/stages/triage.ts` — new file (sub-command handler + `TriageDeps` interface).
- `core/test/triage.test.ts` — unit tests for the new stage.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command.

## Acceptance Criteria

- [ ] `pipeline triage <issue> --stage ready` sets `pipeline:ready` and removes any other `pipeline:<stage>` label; idempotent (re-running when already set is a no-op with a log message).
- [ ] `pipeline triage <issue> --stage backlog` sets `pipeline:backlog` and removes other stage labels; idempotent.
- [ ] Attempting to set a mid-flight stage (e.g. `--stage planning`, `--stage review-2`) exits non-zero with a clear error naming the rejected stage and listing the allowed values (`ready`, `backlog`).
- [ ] No model harness call is made; the command is fully deterministic given the issue labels returned by GitHub.
- [ ] All external I/O is behind a `TriageDeps` seam; unit tests do no real network, git, or subprocess calls.
- [ ] `triage` appears in the pipeline CLI `--help` listing alongside `release`, `intake`, and `sweep`.
- [ ] `npm run ci` passes end-to-end after the change.
