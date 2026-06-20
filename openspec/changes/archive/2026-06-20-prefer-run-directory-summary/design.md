## Overview

This change is confined to the read side of summary mode. The write side (`finalizeRun()`) already produces both `summary.json` in the run directory and the legacy `evidence.json`; no write-path changes are needed.

## Run-directory lookup

`run-store.ts` already exposes `listRunIds(repoDir)` (sorted by mtime descending) and `runDirPath(repoDir, runId)`. Add a thin helper `latestSummaryForIssue(repoDir, issueNumber, deps)` that:

1. Calls `listRunIds(repoDir, deps)` to get all run-ids sorted by recency.
2. Filters to run-ids with the prefix `<issueNumber>-` (the deterministic format from `runIdFor()`).
3. For each candidate (most recent first), attempts `readFile(runDirPath(repoDir, id) + "/summary.json")` and parses it.
4. Returns the first successfully parsed bundle, or `null` if all fail.

The filter by prefix is O(n) over run-ids on disk and requires no additional metadata reads for the happy path (latest run matches on first try). A corrupt `summary.json` is caught and silently skipped.

## `runSummary()` update

```
repoDir  →  latestSummaryForIssue(repoDir, issue)
          ↓ null
         readBundle(stateDir, issue)   [legacy fallback]
          ↓ null
         error: exit 1, print both paths
```

The `repoDir` is already available in the CLI's config context (it's the current working directory). Pass it into `runSummary()` alongside the existing `cfg` and `issueNumber`.

## `pipeline summary <run-id>` dispatch

Add `summary` as a recognized no-issue-number keyword in the CLI positional dispatch (alongside `logs`, `triage`, `init`, etc.). When the next positional argument is a valid run-id string (`<issue>-<timestamp>`), the CLI reads `summary.json` from that exact run directory — no issue-number parsing, no domain config.

Distinguish `pipeline summary <run-id>` from `pipeline N --summary` by checking whether the first positional argument parses as an integer (issue number) vs. a run-id string. The run-id format (`<digits>-<YYYY-MM-DDTHH-MM-SS-mmmZ>`) is unambiguous.

## Deps seam for tests

`latestSummaryForIssue` takes a `RunStoreDeps`-compatible deps object (the same seam used by `listRunIds`/`readEvents`). Unit tests inject an in-memory map of `{ runDir → { "summary.json": content } }` to exercise the priority logic without touching the filesystem.

## No breaking changes

- `--summary` flag and its flag-based invocation are unchanged for callers who already use it.
- The legacy path is still read when the run directory has no match, so existing consumers continue to work.
- `pipeline summary <run-id>` is an additive form.
