## Why

`pipeline scoreboard` reports a single aggregate over the whole selected window
(default: last 30 days). That answers "how is my factory doing?" but not "is it
getting better or worse?" — a maintainer who wants to see whether autonomy rate,
cost, or duration is trending has to re-run the command repeatedly with hand-rolled
`--since`/`--until` pairs and diff the outputs by eye. There is no local way to get a
chronological breakdown, and exporting run artifacts to a hosted analytics product is
out of scope for a self-contained skill.

## What Changes

- `pipeline scoreboard` gains an optional `--bucket day|week` flag.
- When `--bucket` is supplied, the report gains a chronological **series**: one entry
  per period covering the selected window, each carrying the same `totals` and
  `metrics` shapes already produced for the full window, computed only from the runs
  whose resolved start timestamp falls inside that period.
- Period boundaries are UTC and fixed: `day` = the UTC calendar day; `week` = the
  ISO-8601 week (Monday 00:00 UTC → next Monday 00:00 UTC). The first and last periods
  are clipped to the window bounds, so the series covers exactly the selected window.
- Periods with no included runs appear explicitly with zeroed totals and the
  capability's existing zero-denominator rule (`ratio: null`, `avg_ms: null`) — no
  fabricated values, no silent gaps.
- `--json` gains additive top-level `bucket` and `series` keys, present **only** when
  `--bucket` is supplied. Human output gains a per-period section rendering the same
  series.
- The existing full-window summary is unchanged and still present. Omitting `--bucket`
  produces output identical to today's, key-for-key.
- An unsupported `--bucket` value fails with a clear error and a non-zero exit before
  any report bytes are written.

Non-goals: no new run-artifact fields or instrumentation, no changes to existing
metric definitions, no custom bucket sizes, no timezone configuration, no dashboard or
hosted-service integration.

## Capabilities

### Modified Capabilities
- `factory-scoreboard`: adds the optional `--bucket day|week` flag, the UTC period
  boundary rules, the chronological per-period series in both human and JSON output,
  explicit empty periods, validation of unsupported bucket values, and the guarantee
  that the no-`--bucket` output and the full-window summary are unchanged.

## Impact

- `core/scripts/scoreboard.ts` — add `ScoreboardBucket` type and `bucket` option; extract
  the existing per-window aggregation so it can be reused per period; add period-boundary
  computation, run-to-period assignment, series assembly, and human/JSON series rendering
- `core/scripts/pipeline.ts` — add the `--bucket <unit>` CLI option, thread it into the
  early `scoreboard` dispatch, and extend the `scoreboard --help` usage line
- `core/scripts/command-registry.ts` — add `bucket` to the `scoreboard` allowed-flag set
- `core/test/scoreboard.test.ts`, `core/test/pipeline-cli.test.ts`,
  `core/test/command-registry.test.ts` — unit tests for boundaries, empty periods,
  unchanged default output, and rejection of unsupported bucket values
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the flag
- `plugin/` — regenerated mirror (`node scripts/build.mjs`)

## Acceptance Criteria

- [ ] `pipeline scoreboard --json` invoked without `--bucket` produces a JSON object with
      exactly the same key set as before this change (no `bucket` key, no `series` key),
      and the human output contains no per-period section.
- [ ] `pipeline scoreboard --json --bucket day` emits a `series` array whose entries are
      ordered oldest-first and whose consecutive periods are contiguous: each entry's
      `end` equals the next entry's `start`.
- [ ] With `--bucket day`, every series entry's `start`/`end` align to UTC calendar-day
      boundaries except the first entry's `start` and the last entry's `end`, which equal
      the window's `since` and `until` respectively.
- [ ] With `--bucket week`, every series entry's `start`/`end` align to Monday 00:00 UTC
      except the first entry's `start` and the last entry's `end`, which equal the
      window's `since` and `until` respectively.
- [ ] Each series entry exposes `totals` and `metrics` with the same shape as the
      full-window report, and a run contributes to exactly one series entry — the one
      whose half-open `[start, end)` interval contains its resolved start timestamp.
- [ ] A period containing no included runs appears in the series with
      `totals.included_runs: 0`, every rate's `ratio: null`, every duration's `avg_ms:
      null`, and no thrown error.
- [ ] The top-level `window`, `totals`, `metrics`, and `diagnostics` values are
      byte-for-byte identical whether or not `--bucket` is supplied for the same window
      and artifacts.
- [ ] Human output with `--bucket` renders one labelled line-group per period, in the
      same chronological order as the JSON series, including empty periods.
- [ ] `pipeline scoreboard --bucket month` (or any value other than `day`/`week`) exits
      non-zero with an error naming the supported values and writes no report to stdout.
- [ ] Unit tests cover day and week boundary alignment, window clipping, empty periods,
      run-to-period assignment at a period edge, unchanged no-`--bucket` output, and
      unsupported-value rejection — using the existing injected `ScoreboardDeps` seam
      with no real network, git, or subprocess calls.
