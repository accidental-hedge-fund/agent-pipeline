## Why

`--status` on a `needs-human`-parked item prints only the bare stage label, giving the operator no indication of how many findings are blocking or what steps to take. The `needs-human` terminal was added in #110 but its operator-facing `--status` surface was left incomplete.

## What Changes

- `core/scripts/pipeline.ts` (`runStatus`): when the resolved stage is `needs-human`, parse the latest `## Pipeline: Review ceiling reached` comment on the issue and append the unresolved-finding count and the resume steps to the status output.
- A new **pure helper** `needsHumanPunchlist(comments) => string | null` is added (alongside `runStatus` or in a dedicated module) — it receives the issue's comment list, locates the ceiling comment, extracts the blocking-finding count, and returns the formatted punch-list string. Returns `null` if no ceiling comment exists (graceful fallback).
- Unit tests cover: ceiling comment present → count + hint; no ceiling comment → null; non-`needs-human` stage → `runStatus` output unchanged.

## Capabilities

### New Capabilities
- `needs-human-status-surface`: `--status` on a `needs-human` item SHALL print the unresolved blocking-finding count and the resume steps derived from the latest ceiling comment, in addition to the bare stage line.

### Modified Capabilities
- `pipeline-state-machine`: The `--status` command gains a stage-conditional enrichment for the `needs-human` terminal.

## Impact

- `core/scripts/pipeline.ts` (`runStatus` + new pure helper).
- `core/test/pipeline-status.test.ts` (new) or extension of an existing status test file.
- No changes to the state-machine edges, stage handlers, or any other pipeline stage.
- Read-only: `--status` makes no mutations; this change introduces no new mutations.
