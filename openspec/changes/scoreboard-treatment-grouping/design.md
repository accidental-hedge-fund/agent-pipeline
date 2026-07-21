## Context

`core/scripts/scoreboard.ts` runs a two-phase pipeline: `scanRunStore()` reads
`.agent-pipeline/runs/*/{run.json,events.jsonl,summary.json}`, then a reducer produces a
`ScoreboardReport`. Metrics fall into two families:

- **Run-scoped** — `ready_to_deploy_without_human_intervention`, `full_run_duration_ms`,
  `blocker_rate_by_kind`, `needs_human_rate`, `gate_pass_rates`, and the per-PR rates.
  Their unit of observation is a whole pipeline run (or a PR), which spans many stages
  and, in a mixed configuration, many harnesses and models.
- **Record-scoped** — `cost_accounting`, reduced from `stage_accounting` records
  (`collectAccountingRecords()` → `normalizeAccountingRecord()`). Its unit of observation
  is a single harness invocation, which carries exactly one treatment identity:
  `harness`, `model`, `model_slot`, and optionally `executor_provider`/`executor_model`
  (#314).

`cost_accounting.groups` already exists but is keyed on a fixed six-tuple
(`issue × stage × harness × model_slot × model × outcome`) — useful as raw material,
too fine to read as a comparison.

## Goals / Non-Goals

Goals:
- One opt-in flag that collapses the record-scoped metrics along a single recorded
  identity dimension, reusing the existing per-record normalization so group numbers
  cannot drift from the window's `cost_accounting` totals.
- Honest identity: never coerce a missing value into a plausible one; never silently
  merge "we don't know" with "this doesn't apply".
- Default output unchanged, byte-for-byte.

Non-Goals:
- Splitting run-scoped metrics by treatment identity (decision 2).
- Multi-dimensional grouping, significance testing, paired comparison, ranking, or
  recommendations.
- Any dimension that identifies a person, team, customer, or organization.
- An HTML or hosted export surface.

## Decisions

### 1. `--by` takes exactly one dimension, validated before any I/O

`parseScoreboardGroupBy()` mirrors `parseScoreboardBucket()`: it returns `null` for an
absent flag, throws for an unsupported value naming all four supported dimensions, and
throws for a repeated flag stating that exactly one dimension is supported. It is called
before `scanRunStore()`, so an invalid invocation produces no partial report. The CLI
option is therefore collected as a repeatable list (like `--estimate-cost`) purely so a
second occurrence can be *detected and rejected* rather than silently last-wins — the
issue requires "only one generic grouping dimension is accepted per invocation", and
commander's default single-value behaviour would silently swallow the first.

### 2. Grouping applies to record-scoped metrics only

A treatment identity is a property of a harness invocation, not of a run. A single run
routinely plans on one model and reviews on another, and delegates a stage to an external
executor. Attributing that run's autonomy outcome, full duration, or blocker kind to
"claude" or to "opus" would be a fabricated attribution — precisely the kind of
unfalsifiable productivity claim the issue's scope boundary rules out.

So `grouping.groups[]` carries the record-scoped metric shape (`CostAccountingTotals`
plus per-group cost-source coverage) and nothing else. Run-scoped metrics remain
window-level and are untouched by `--by`. The spec states this explicitly so a later
reviewer does not read the omission as an oversight.

Consequence: `--by` is a *lens on cost accounting*, and the guarantee that makes it
trustworthy is conservation — per-group sums equal the window's
`cost_accounting.totals`.

### 3. Identity resolution: verbatim, with `unknown` and `not applicable` distinct

| dimension  | source field                                | `not applicable` when                    |
|------------|---------------------------------------------|------------------------------------------|
| `harness`  | `harness`                                    | never (the field is required)            |
| `model`    | `model`                                      | never                                    |
| `effort`   | `effort` (see decision 5)                    | never                                    |
| `executor` | `executor_provider`                          | record has no executor evidence at all   |

Rules:
- A present, non-empty string is used **verbatim** as the group key — no lowercasing, no
  alias folding, no normalization. Two spellings of the same model are two groups; the
  scoreboard reports what was recorded, and inventing an equivalence table would be an
  unverifiable claim about the operator's configuration.
- Absent/empty → the literal key `unknown`.
- Structurally inapplicable → the literal key `not applicable`.
- `unknown` and `not applicable` are never merged with each other or with a real value,
  and a record never contributes to zero groups. `normalizeAccountingRecord()` already
  drops malformed records (missing `issue`/`stage`/`harness`/`outcome`) before this
  point; grouping introduces no additional drop.

`harness` is a required field on the record, so `--by harness` should never produce
`unknown` in practice; the rule is still specified for defensive symmetry against
hand-edited or truncated artifacts.

### 4. Harness and executor are separate dimensions over separate fields

Per `types.ts`, when a stage is delegated to an external executor the record's `harness`
field carries the **executor name** from `stage_executors:`, while `executor_provider`
carries the provider id or model-endpoint base URL and `executor_model` the model name.
The two are therefore *not* redundant, and collapsing them would destroy exactly the
distinction the issue's acceptance criteria call out.

`--by harness` groups on `harness` verbatim (executor-name values included, unaltered).
`--by executor` groups on `executor_provider`, reports `executor_model` values observed
in that group as a detail list, and puts every local-harness record under
`not applicable`. A delegated record that recorded no provider is `unknown` — a real
distinction from `not applicable`, and both may appear in one report.

### 5. `--by effort` requires an additive `effort` field — conflict surfaced, not averaged

The issue asks for `--by effort` and simultaneously puts "new event fields" out of scope.
Those are not jointly satisfiable: per-stage reasoning effort is resolved from
`cfg.effort.*` and passed to the harness as `--effort` / `-c model_reasoning_effort`
(`harness.ts`, #366), but `buildStageAccountingRecord()` never persists it and
`StageAccountingRecord` has no such field. Grouping on a field that does not exist would
put 100% of records in `unknown` — a flag that ships broken.

Chosen resolution: add `effort` as an **optional** field on
`BuildStageAccountingRecordInput` and `StageAccountingRecord`, populated from the value
already resolved at each call site. This is the same additive shape as `cost_source`
(#429) and `executor_provider`/`executor_model` (#314): no required field added, none
removed, older records stay readable and simply group as `unknown`.
`STAGE_ACCOUNTING_SCHEMA_VERSION` is bumped additively, matching the #429 precedent, and
readers must not gate on a specific version (existing rule).

Alternative rejected: derive effort from the current config at report time. The
scoreboard reads historical artifacts; the config may have changed since, so this would
retroactively relabel past runs with today's settings — an actively misleading answer.

### 6. Composition with `--bucket` reuses the same reducer per period

`--bucket` already partitions scanned runs and re-runs the metric reducer per period
(#425). Grouping is computed inside that reducer, so `--bucket day --by harness` yields a
`grouping` object per series entry with no extra machinery and no possibility of the
series and the summary using different grouping logic. Per-period conservation holds
against that period's `cost_accounting.totals`.

### 7. Additive, conditional JSON keys — `schema_version` stays `1`

`by` and `grouping` are emitted only when `--by` is supplied, exactly as `bucket`/`series`
were. Consumers that never pass `--by` see a byte-identical object. The report's
`schema_version` stays `1`, consistent with how `cost_accounting`, `coverage`, and
`bucket`/`series` were added.

The payload is deliberately a flat array of self-describing group objects, so a future
renderer (HTML or otherwise) can consume it unchanged — but this change specifies no such
renderer, because none exists today.

### 8. Deterministic group ordering

Groups are sorted by descending `invocation_count`, then by group key ascending
(`localeCompare`) as a tiebreaker, with `unknown` and `not applicable` sorted by the same
rule rather than pinned. Deterministic ordering keeps the JSON diffable between runs and
the human section stable; count-descending puts the dominant configuration first, which
is what a maintainer scans for.

## Risks / Trade-offs

- **`--by effort` is retroactively blind.** Records written before this change carry no
  effort, so a window spanning the upgrade shows a large `unknown` group. That is the
  honest report — the alternative (decision 5's rejected option) fabricates history. The
  human output labels the group plainly so the cause is visible.
- **Verbatim keys can fragment.** `claude-opus-4-8` and `opus` would be two groups if both
  were recorded. Accepted: the scoreboard reports recorded identity, and an alias table
  would be a guess about the operator's intent.
- **Threading `effort` through stage call sites touches several files.** Each edit is a
  one-argument addition at an existing `buildStageAccountingRecord()` call; a stage missed
  in the sweep degrades to `unknown` rather than to a wrong value, and the tests assert
  the field is populated for the routed stages.

## Migration Plan

None required. The flag is opt-in, the default path is unchanged, and the accounting
field is optional and backward-compatible in both directions.

## Open Questions

None blocking. One deviation is recorded for the reviewer rather than left implicit: the
additive `effort` field in decision 5 goes beyond the issue's "no new event fields"
non-goal, because the `--by effort` acceptance criterion cannot be met without it.
