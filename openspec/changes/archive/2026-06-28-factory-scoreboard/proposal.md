## Why

The pipeline already records per-run artifacts for stages, reviews, blockers,
human interventions, and final state, but there is no factory-level view that
answers whether autonomous development is becoming faster, cheaper, and more
reliable over time. Operators need a read-only report that rolls those existing
artifacts up into throughput, autonomy, cost, and reliability metrics.

## What Changes

- Add a factory scoreboard report command that scans `.agent-pipeline/runs/**`
  over a configurable time window.
- Derive aggregate metrics from existing `run.json`, `events.jsonl`, and
  `summary.json` artifacts rather than introducing a second state machine.
- Emit the scoreboard in both human-readable text and an unfenced JSON form.
- Surface missing, partial, corrupt, or insufficient historical artifacts as
  diagnostics while continuing to report all metrics that can be proven.
- Support cost-per-ready-PR using actual recorded usage/cost when available and
  explicit caller-provided estimates when actual usage is absent.

## Acceptance Criteria

- [ ] Running the scoreboard over a fixture run store with `--since`/`--until`
      or an equivalent configurable time window includes only runs in that
      window and prints a human-readable report.
- [ ] Running the same report with `--json` emits exactly one parseable JSON
      object with no surrounding prose or Markdown fences.
- [ ] The human and JSON outputs expose these metrics: percent ready-to-deploy
      without human intervention, cost per ready PR, wall-clock duration per
      stage and per full run, harness calls per successful PR, retry/fix-round
      count per PR, blocker rate by blocker kind, `pipeline:needs-human` rate,
      same-harness fallback rate, and test/eval/shipcheck pass rates.
- [ ] The report reads only existing run artifacts (`run.json`, `events.jsonl`,
      and `summary.json`) and does not mutate GitHub labels/comments, worktrees,
      pipeline config, or run-state files.
- [ ] Missing files, corrupt JSON, partial `events.jsonl` tails, absent
      `summary.json`, and unknown event fields are represented as diagnostics
      without crashing the report.
- [ ] Cost reporting distinguishes actual, estimated, and missing cost inputs;
      when actual usage is unavailable and no explicit estimate is supplied, the
      affected cost value is reported as unavailable with a diagnostic rather
      than silently using zero.
- [ ] Historical runs that cannot prove a specific metric still contribute to
      other metrics they can prove, and the JSON output includes per-diagnostic
      file paths and reason codes.

## Capabilities

### New Capabilities
- `factory-scoreboard`: Read-only factory-level metrics over existing pipeline
  run artifacts.

### Modified Capabilities
- None.

## Impact

- Adds a new no-issue-number CLI/report surface in the pipeline core.
- Adds aggregation and formatting logic over run-store artifacts plus focused
  unit tests with filesystem fixtures.
- Requires README/help documentation updates during implementation.
- Does not change the pipeline stage machine, labels, merge behavior, or run
  artifact write contract.
