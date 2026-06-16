## Context

#147 established `evidence.json` as a single JSON blob at `<stateDir>/<issue>/evidence.json`, atomically overwritten on every stage update. This design is O(n) for a live poller (must re-read the whole file to find new events) and cannot be followed with `tail -f`. After a crash the file is readable but cannot be streamed. Pipeline Desk currently uses PTY regex-parsing to track stage progress, which is fragile and couples the desktop app to human-readable prose.

The gstack `lib/jsonl-store.ts` reference implementation shows the proven pattern: `appendJsonl` with O_APPEND for atomic single-line writes (one line always fits within the OS page size on local filesystems), `readJsonl` that skips corrupt/partial tail lines and preserves unknown fields. CEP uses the same run-ID-keyed directory with `metadata.json` at init.

## Goals / Non-Goals

**Goals**
- Provide an append-only event log (`events.jsonl`) that Pipeline Desk can tail for stage timeline rendering — zero prose parsing.
- Provide a stable, crash-safe run directory that persists after process exit.
- Provide `pipeline logs <run-id> --follow` to tail `terminal.log` without needing the parent process alive.
- Provide `--json-events` for desktop integration via stdout JSON lines.
- Keep all recorded content from #147 identical — only the persistence shape changes.
- Keep the legacy `<stateDir>/<issue>/evidence.json` path readable for backward compat.

**Non-Goals**
- Changing what is recorded (content from #147 is preserved verbatim).
- Real-time IPC, daemon processes, or in-memory event buses (the `run-artifact-conventions` spec prohibits these).
- Remote sync or cloud artifact storage.
- Breaking the PTY fallback path for older pipeline versions.

## Decisions

**Decision: run-id as `<issue>-<sanitized-ISO-timestamp>`.**
The run-id is formed by concatenating the issue number and the UTC start timestamp (colons replaced with hyphens, milliseconds dropped), e.g. `155-2026-06-16T21-11-35Z`. This is deterministic within a run, human-readable for debugging, and globally unique enough for local usage. The run directory is `.agent-pipeline/runs/<run-id>/`.

*Alternative considered:* short random UUID — opaque, harder to map back to an issue in a `ls` listing.

**Decision: `events.jsonl` uses O_APPEND; readers skip partial tail lines.**
Each `appendEvent()` opens the file with `O_APPEND | O_WRONLY | O_CREAT`, writes a single newline-terminated JSON line, and closes. This is atomic for lines well under the OS page size (~4 KB) on local filesystems. `readEvents()` splits on `\n`, attempts `JSON.parse` on each part, and silently skips non-parseable entries (corrupt partial tail from a crash). Unknown fields are preserved (no stripping) so future event types don't break old readers.

*Alternative considered:* file locking around a full-file rewrite — preserves existing #147 pattern but remains non-tail-able.

**Decision: `terminal.log` always written, even in `--json-events` mode.**
`terminal.log` captures raw combined output by piping the pipeline's stdout/stderr through a tee-like write before normal handling. This ensures the PTY fallback path for older Pipeline Desk versions is intact and `logs --follow` always has a file to tail.

**Decision: `--json-events` duplicates each event to stdout as a JSON line.**
When `--json-events` is active, `appendEvent()` also writes the same JSON line to `process.stdout`. Human-readable logs go to `terminal.log` and stderr as normal. Pipeline Desk can read stdout in `--json-events` mode for live events, or tail `events.jsonl` after the fact.

**Decision: `summary.json` is the finalized bundle; `evidence.json` kept via copy.**
At finalization, `formatSummary(bundle)` is written to `summary.json` in the run directory. For backward compat, the same content is also written to `<stateDir>/<issue>/evidence.json`. This is a copy (not a symlink) to avoid cross-filesystem issues. Old consumers reading the legacy path get the full finalized bundle. The legacy path write is non-fatal (following `run-artifact-conventions`).

**Decision: `run-store.ts` injectable deps.**
`initRunDir`, `appendEvent`, and `finalizeRun` take a `RunStoreDeps` parameter (`fs`, `now`) following the existing `AdvanceReviewDeps`/`ShaGateDeps` seam pattern. Unit tests pass fakes; no real filesystem calls in tests.

**Decision: `pipeline logs <run-id> --follow` uses Node `child_process.spawn(['tail', '-f', terminal.log])`.**
`tail -f` is available on all target platforms (macOS, Linux) and correctly handles the file existing after the parent process exits. The command exits with non-zero if the run directory doesn't exist or `terminal.log` is absent.

## Risks / Trade-offs

- *O_APPEND on NFS or network filesystems*: not atomic. Run directories are local-only (`_localPath` convention from `run-artifact-conventions`); this is acceptable.
- *Partial last line in `events.jsonl`*: the reader skips it, so at most one event is lost per crash — the `run_complete` or final `stage_complete`. Tolerable; `summary.json` covers the finalized state.
- *summary.json written after crash*: if the pipeline crashes before finalization, `summary.json` is absent. Consumers MUST handle this; `run.json` and `events.jsonl` are always present and sufficient for timeline reconstruction.
- *Disk accumulation*: run directories are never auto-cleaned in this change. Future cleanup policy is out of scope.

## Migration Plan

1. `run-store.ts` is additive — existing stage calls to `evidence.ts` are not removed in this change; they remain alongside the new `appendEvent()` calls until a follow-up migration removes the redundancy.
2. The legacy `<stateDir>/<issue>/evidence.json` write is retained so no existing consumer breaks.
3. Pipeline Desk backward-compat: if it finds no `.agent-pipeline/runs/` directory it falls back to PTY streaming (no behavioral change for older pipeline versions).
