## Why

The pipeline accumulates run evidence — events, summaries, review findings, override records — but nothing reads across runs to surface repeating problems. Repeated blockers, recurring review findings, flaky gates, and token-wasting patterns stay buried in terminal history instead of becoming explicit improvement work.

## What Changes

- Adds a `pipeline improve` subcommand (and a standalone `pipeline-improve.ts` module) that reads existing run artifacts read-only and clusters patterns into candidate improvement work.
- Dry-run mode (default) prints a structured report of clustered problems: affected runs/issues, evidence excerpts, and a proposed issue title.
- Optional `--apply` flag creates GitHub issues from the top-N clusters; each issue includes source run IDs and evidence excerpts so a maintainer can independently verify the pattern before acting.
- The analyzer never writes labels, branches, PRs, worktrees, or pipeline config — it is strictly read-then-optionally-create-issue.

## Capabilities

### New Capabilities
- `improve-command`: The `pipeline improve` CLI subcommand — reads `.agent-pipeline/runs/**/events.jsonl`, `summary.json`, review-finding records, and override records; clusters repeated failure patterns by category (review findings, blockers, flaky gates, token waste); emits a dry-run report or optionally creates GitHub issues.

### Modified Capabilities
<!-- none — this change reads from existing run artifacts without changing their spec-level requirements -->

## Impact

- New source file: `core/scripts/stages/improve.ts` (or `core/scripts/improve.ts` at CLI dispatch level).
- New CLI subcommand: `pipeline improve [--apply] [--top N] [--since <date>]`.
- Reads: `run-directory-layout`, `run-artifact-conventions`, `events-jsonl-streaming`, `evidence-bundle`, `review-finding-records` (no spec changes to these).
- Writes: GitHub issues only (via `gh issue create`), guarded by `--apply`.
- No changes to the pipeline state machine, merge surface, or existing stages.
