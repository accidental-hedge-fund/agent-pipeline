## Why

Issue #147 established `evidence.json` as a monolithic JSON blob rebuilt atomically on every stage update — O(n) for a live poller and impossible to `tail -f` after a crash. Pipeline Desk needs to render a real-time stage timeline without parsing terminal prose, and both the desktop app and terminal users need an artifact that survives parent-process crashes and remains inspectable.

## What Changes

- **Run directory layout** — each run gets a stable, crash-safe directory at `.agent-pipeline/runs/<run-id>/` created before the first stage runs, containing `run.json`, `events.jsonl`, `terminal.log`, and `summary.json`.
- **Append-only event log** — `events.jsonl` replaces monolithic `evidence.json` in-place rebuilds; stage lifecycle and key events are appended atomically one line at a time. Readers tolerate partial tail lines and preserve unknown fields for forward-compat.
- **`--json-events` flag** — each event appended to `events.jsonl` is also written to stdout as a JSON line; human-readable output continues to `terminal.log`.
- **`pipeline logs <run-id> --follow`** — tails `terminal.log` independent of the original parent process; works after a crash.
- **`summary.json`** — the finalized evidence bundle (`formatSummary` output) written to the run directory at finalization. After finalization the legacy `<stateDir>/<issue>/evidence.json` path is kept readable (via copy or retained write) for backward compat.
- The recorded **content** (stages, commands, prompts, overrides, recoveries, value-redaction) is unchanged from #147 — only the **persistence shape** changes.

## Capabilities

### New Capabilities

- `run-directory-layout`: Stable run-id-keyed directory at `.agent-pipeline/runs/<run-id>/`; created before the first stage, crash-safe, contains `run.json`, `events.jsonl`, `terminal.log`, and `summary.json`.
- `events-jsonl-streaming`: Append-only JSONL event log format; `--json-events` flag streams lifecycle events to stdout; reader is forward-compat (tolerates partial lines and unknown fields).
- `log-follow-command`: `pipeline logs <run-id> [--follow]` command — prints or follows `terminal.log` independent of the original parent process.

### Modified Capabilities

- `evidence-bundle`: Persistence path and write semantics updated to use the run directory. Incremental stage writes become `appendEvent()` calls to `events.jsonl`; the finalized bundle is `summary.json`. The legacy `<stateDir>/<issue>/evidence.json` path remains readable after finalization.

## Acceptance Criteria

- [ ] Pipeline Desk can render a full stage timeline by reading `events.jsonl` with zero prose parsing.
- [ ] The run directory remains on disk and is fully inspectable after an unexpected process exit.
- [ ] `terminal.log` is written in all modes (standard, `--json-events`, PTY fallback).
- [ ] `pipeline logs <run-id> --follow` streams new output after the original parent process exits.
- [ ] `--json-events` writes the same JSON line to both `events.jsonl` and stdout for every lifecycle event.
- [ ] Legacy consumers reading `<stateDir>/<issue>/evidence.json` continue to get the finalized bundle content.
- [ ] Every `events.jsonl` record and every file in the run directory carries `schema_version`.
- [ ] Readers skip corrupt or partial tail lines in `events.jsonl` rather than throwing.
- [ ] Unknown fields in JSONL records are preserved by `readEvents()`.
- [ ] A Pipeline Desk that finds no run directory (older pipeline version) falls back to PTY streaming.

## Impact

- `core/scripts/pipeline.ts` — run-id generation, `--json-events` flag, `logs` subcommand.
- `core/scripts/` — new `run-store.ts` managing run directory init, event append, finalization.
- `core/scripts/stages/*.ts` — stage recording calls updated to use `appendEvent()` and run directory.
- `openspec/specs/evidence-bundle/spec.md` — persistence path and write semantics updated.
- `core/test/` — new tests for run-store, events.jsonl, `--json-events`, `logs --follow`, backward compat.
