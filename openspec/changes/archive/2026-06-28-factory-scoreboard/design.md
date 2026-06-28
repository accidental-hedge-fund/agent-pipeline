## Context

The pipeline already writes durable run artifacts under
`.agent-pipeline/runs/<run-id>/`: immutable run identity in `run.json`,
append-only lifecycle events in `events.jsonl`, terminal evidence in
`summary.json`, and legacy evidence copies for older consumers. Existing specs
also define human-intervention events, review records with same-harness
self-review markers, stage lifecycle events, and non-fatal artifact handling.

Issue #301 needs a factory-control surface over those artifacts. The scoreboard
must answer whether the factory is improving without becoming another source of
truth for pipeline state.

## Goals / Non-Goals

**Goals:**
- Provide a read-only `pipeline scoreboard` report over a configurable time
  window.
- Produce both human-readable and machine-readable JSON output.
- Derive all metrics from existing run artifacts and preserve historical
  tolerance for missing or corrupt artifacts.
- Make metric denominators, unavailable values, and diagnostics explicit.
- Support cost metrics from actual recorded usage when present and explicit
  estimates when not.

**Non-Goals:**
- No new state machine, persistent scoreboard cache, background daemon, or event
  bus.
- No mutation of GitHub labels/comments, worktrees, run artifacts, or pipeline
  config during report generation.
- No product analytics, per-user telemetry, remote upload, merge, or deploy
  behavior.
- No attempt to reconstruct data that historical artifacts cannot prove without
  surfacing a diagnostic.

## Decisions

1. **Expose a no-issue-number `pipeline scoreboard` command.**
   The command fits existing no-issue report surfaces (`summary`, `logs`,
   `doctor`, `config`) and avoids overloading `status`, which is issue-scoped.
   It accepts `--since`, `--until`, and `--days` for the window, `--json` for
   machine output, and repeatable `--estimate-cost <harness>=<usd-per-call>`
   flags for explicit estimates.

   Alternative considered: add this under `improve` because
   `improve --interventions` already aggregates intervention events. That would
   hide a factory-wide operational report behind an optimization subcommand and
   make JSON/human behavior less discoverable.

2. **Use run directories as the only input source.**
   The scanner walks `.agent-pipeline/runs/*/` and reads `run.json`,
   `events.jsonl`, and `summary.json` when present. Run start time is resolved
   from `run.json.started_at`, then a `run_start` event, then the run-id
   timestamp as a compatibility fallback. This keeps the scoreboard aligned with
   the current artifact contract and avoids live GitHub calls.

   Alternative considered: query GitHub labels/comments to reconstruct old
   history. That would be slower, less deterministic, and would violate the
   issue goal to read existing run artifacts rather than create another state
   model.

3. **Represent rates with explicit numerators and denominators.**
   JSON rate fields should carry `{ numerator, denominator, ratio }`, with
   `ratio: null` for a zero denominator. Human output can format those rates as
   percentages, but the JSON contract must remain auditable.

   Alternative considered: emit only rounded percentages. That makes small
   samples and unavailable denominators ambiguous.

4. **Fuse summary and events without double-counting.**
   `summary.json` is preferred for finalized stage/review records because it is
   the finalized evidence bundle. `events.jsonl` is used for lifecycle timing,
   human-intervention events, blocker events, `run_complete.elapsed_ms`, and any
   additive usage/cost fields. If both sources describe the same review or stage
   visit, the implementation should count the logical visit once.

   Alternative considered: use only `summary.json`. That would omit partial
   runs, human-intervention events, and timing details that exist only in the
   event stream for some historical runs.

5. **Cost is source-tagged, not guessed.**
   Actual numeric `cost_usd` values found in existing artifact records win. If a
   harness call lacks actual cost and the caller supplies an estimate for that
   harness, the estimate is applied and marked as estimated. If neither exists,
   the call contributes a missing-cost diagnostic and any aggregate that requires
   complete cost coverage is unavailable.

   Alternative considered: default missing costs to zero. That would make
   autonomy look cheaper as artifacts get less complete.

## Risks / Trade-offs

- Historical artifacts are incomplete or schema-mixed -> diagnostics identify
  which files and metrics are affected, while unaffected metrics still render.
- Cost estimates are coarse -> JSON separates actual and estimated totals and
  includes missing-call counts so consumers can judge confidence.
- Large run stores may grow over time -> implementation should stream/read files
  once per run directory and avoid reading `terminal.log`.
- Duplicate evidence across `summary.json` and `events.jsonl` can inflate
  counts -> aggregation uses stable run/stage/review keys before computing
  metrics.

## Migration Plan

No data migration is required. Existing run artifacts remain valid inputs. The
implementation will add the CLI/report surface, unit fixtures, README/help
updates, and generated plugin mirror updates. Rollback is removing the command
and helper code; no persisted scoreboard state needs cleanup.

## Open Questions

None for this proposal. Future changes may add richer actual usage artifacts,
but this change must work with the current run store and explicit estimates.
