## Why

Today the pipeline's per-stage timing evidence is only readable from local disk. At
finalization the pipeline posts a single PR/issue comment that records **just the local
path** of the evidence bundle (`notifyBundlePath` in `pipeline-run.ts`) and tells the
reader to run `pipeline N --summary`. A reviewer on a different machine than the one that
ran the pipeline cannot see how long each stage took or why a PR needed multiple rounds —
the timing table lives in `.agent-pipeline/runs/<run-id>/summary.json` (or the legacy
`/tmp/pipeline-<domain>/<issue>/evidence.json`), both unreachable from GitHub.

Separately, the legacy issue-scoped bundle at `<stateDir>/<issue>/evidence.json` is
**overwritten on every run** (`createBundle` writes a fresh skeleton; `finalizeRun`
rewrites the legacy file). Per-run `summary.json` files survive under distinct run
directories, but there is no single append-only artifact that preserves the timing/outcome
of *every* run for an issue — so resuming a pipeline after a fix round loses the earlier
rounds' at-a-glance history unless a maintainer knows to enumerate run directories by hand.

## What Changes

- The finalization PR/issue comment (`notifyBundlePath`) is enriched so its body itself is
  fully self-contained on GitHub: it renders a Markdown **per-stage timing table** (one row
  per recorded stage: stage name, `enteredAt`→`exitedAt`, duration, outcome) and shows the
  **run id** as a visible field. The local run-directory path stays in the comment as
  secondary/optional context, but the timing table and outcome are readable without
  following it.
- The comment continues to satisfy the existing "public finalization comments do not
  include accounting payloads" contract: wall-clock stage durations are surfaced, but no
  token counts, cost values, prompts, responses, transcripts, or provider payloads.
- A new **append-only issue-level evidence history artifact** records one compact entry per
  finalized run for an issue (run id, per-stage timings, outcome). A re-run **appends** a
  new entry rather than replacing prior ones, so an issue with N finalized runs yields
  exactly N entries. This is written at finalization, alongside the existing summary.json /
  legacy evidence.json writes, and is non-fatal (a write error never fails the run).
- The legacy `<stateDir>/<issue>/evidence.json` write path is unchanged, so existing local
  consumers (e.g. `pipeline N --summary`) keep working with no behavior change.

## Capabilities

### New Capabilities
- `issue-evidence-history`: an append-only, issue-scoped JSONL artifact that accumulates a
  compact per-run timing/outcome record for every finalized run of an issue, its on-disk
  location, entry schema, append (never-overwrite) semantics, and its non-fatal write
  contract.

### Modified Capabilities
- `evidence-bundle`: the single finalization PR/issue comment now embeds a per-stage timing
  table and the visible run id directly in the comment body (durable on GitHub), while still
  referencing the local bundle path as secondary context and still omitting accounting
  payloads.

## Acceptance Criteria

- [ ] The finalization PR/issue comment for a finalized run contains a table with one row
      per recorded stage, each showing: stage name, `enteredAt`→`exitedAt` timestamps,
      duration, and outcome.
- [ ] The finalization comment shows the run id as a visible field, not only embedded inside
      a file path.
- [ ] The finalization comment still references the local run-directory path
      (`.agent-pipeline/runs/<run-id>/summary.json`) and/or `pipeline N --summary` as
      secondary/optional context.
- [ ] The comment's timing table, run id, and outcome are complete using only data carried
      in the comment body — no field depends on local filesystem access to render, so it is
      correct when viewed from a different machine.
- [ ] The finalization comment contains no accounting payloads: no token counts, cost
      values, prompts, responses, transcripts, or provider payloads.
- [ ] For an issue with multiple finalized runs, the issue-level history artifact contains an
      entry for every prior run, not just the most recent one.
- [ ] Re-running the pipeline on an issue that already has history appends a new entry to the
      issue-level history artifact rather than replacing existing entries.
- [ ] Given an issue with N finalized runs, the issue-level history artifact contains exactly
      N run entries, each with its own run id, per-stage timings, and outcome.
- [ ] The legacy `<stateDir>/<issue>/evidence.json` (`/tmp/pipeline-<domain>/<issue>/evidence.json`)
      continues to be written and read exactly as before; existing consumers such as
      `pipeline N --summary` work without error after this change.
- [ ] History-artifact and comment failures are non-fatal: a write or post error is logged
      and the run still completes.

## Impact

- `core/scripts/pipeline-run.ts` — `notifyBundlePath` builds the enriched comment body
  (timing table + run id) from the finalized bundle instead of the path-only body.
- `core/scripts/evidence-bundle.ts` — a pure helper that renders the per-stage timing table
  as Markdown from an `EvidenceBundle` (reusing the existing `formatDuration` logic), so the
  comment builder and tests share one formatter.
- `core/scripts/run-store.ts` — `finalizeRun` appends the compact per-run entry to the
  issue-level history JSONL (append-only, non-fatal) after writing summary.json/evidence.json.
- `core/scripts/types.ts` — a small record type for the history entry (run id, per-stage
  timings, outcome).
- `core/test/` — unit tests for the Markdown timing-table renderer (no local FS deps in the
  body), the append-only history semantics (N runs → N entries; re-run appends), and the
  no-accounting-payload guarantee of the comment body.
