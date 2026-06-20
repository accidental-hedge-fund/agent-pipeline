## Why

`pipeline N --summary` reads the legacy `/tmp/pipeline-<domain>/<issue>/evidence.json` path, but the durable run directory `.agent-pipeline/runs/<run-id>/summary.json` is the documented primary evidence artifact and survives across reboots and domain changes. The mismatch means users who rely on `--summary` get stale or missing data whenever `/tmp` is cleared, even though the canonical record is still on disk.

## What Changes

- `runSummary()` in `pipeline.ts` resolves the latest run directory for the given issue number by scanning `.agent-pipeline/runs/`, sorting by mtime, and reading `summary.json` from the most-recent matching entry.
- Legacy `/tmp/pipeline-<domain>/<issue>/evidence.json` is retained as a fallback when no run-directory `summary.json` exists (backward compatibility for runs that predate the run-directory layout or where `.agent-pipeline/` is inaccessible).
- The error message when no summary is found is updated to name both locations so users understand where to look.
- `pipeline summary <run-id>` is added as an exact-selection form: given a full run-id string, the CLI reads `summary.json` from `.agent-pipeline/runs/<run-id>/` and prints the summary — no issue number required, no ambiguity across multiple runs.
- No change to the write side: `finalizeRun()` already writes both `summary.json` (run directory) and `evidence.json` (legacy). The change is read-order only.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `evidence-bundle`: The `--summary` requirement changes: (1) reads from the run-directory `summary.json` of the latest matching run first, falls back to the legacy path only when no run-directory summary is available; (2) adds `pipeline summary <run-id>` for exact run selection by run-id.

## Impact

- `core/scripts/pipeline.ts` — `runSummary()` and the CLI dispatch block (new `summary <run-id>` positional form).
- `core/scripts/run-store.ts` — expose or reuse `listRunIds()` and `runDirPath()` for the lookup; add a `latestRunIdForIssue()` helper that returns the most-recent run-id whose issue field matches (scanned from `run.json` or inferred from the run-id prefix).
- `core/test/pipeline-summary.test.ts` (new) — unit tests for the read-priority logic and the exact-selection form.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the updated `--summary` behavior and the new `pipeline summary <run-id>` form.

## Acceptance Criteria

- [ ] `pipeline N --summary` reads `summary.json` from the latest run directory for issue N (`.agent-pipeline/runs/<run-id>/summary.json`) and prints the human-readable summary.
- [ ] When no run-directory `summary.json` exists for issue N but the legacy `/tmp/pipeline-<domain>/<issue>/evidence.json` does, `pipeline N --summary` falls back to the legacy path and prints the summary without error.
- [ ] When neither location has a bundle for issue N, the command exits non-zero and the error message names both the run-directory path and the legacy path.
- [ ] `pipeline summary <run-id>` reads `summary.json` from `.agent-pipeline/runs/<run-id>/` for the exact run-id and prints the summary; exit 0 on success, exit non-zero with a clear error if the run-id directory or `summary.json` is absent.
- [ ] `pipeline summary <run-id>` does not require or consume any domain config (`--domain`); the run directory path is derived from the repo root alone.
- [ ] A corrupt or unreadable `summary.json` in the run directory is treated as absent for the purpose of the fallback: the command falls back to the legacy path rather than crashing.
- [ ] All new logic is covered by unit tests with injectable I/O deps (no real filesystem, git, or subprocess calls in tests).
- [ ] `npm run ci` passes end-to-end after the change.
