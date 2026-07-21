## 1. Reducer refactor (behaviour-preserving)

- [ ] 1.1 In `core/scripts/scoreboard.ts`, extract the body of `aggregateRuns()` so the
      metric reduction can be invoked for an arbitrary `(window, runs, estimates)` triple,
      keeping the existing full-window call path and its output identical.
- [ ] 1.2 Add a regression test asserting `pipeline scoreboard --json` output (no
      `--bucket`) is unchanged by the refactor — same key set, same values, for a fixture
      run store.

## 2. Bucket option plumbing

- [ ] 2.1 Add `ScoreboardBucket = "day" | "week"` and an optional `bucket` field to
      `ScoreboardOpts`.
- [ ] 2.2 Add a `parseScoreboardBucket()` validator that returns `null` for an absent flag
      and throws an error naming `day` and `week` for any other value; call it before any
      artifact scanning so failure produces no partial output.
- [ ] 2.3 Add `--bucket <unit>` to the `scoreboard` command in `core/scripts/pipeline.ts`,
      thread `opts.bucket` into the early scoreboard dispatch, and extend the
      `scoreboard --help` usage line.
- [ ] 2.4 Add `bucket` to the `scoreboard` entry's `allowedFlags` in
      `core/scripts/command-registry.ts`.

## 3. Period computation and partitioning

- [ ] 3.1 Implement UTC period-boundary generation: `day` floors to `00:00:00.000Z`;
      `week` floors to Monday `00:00:00.000Z`.
- [ ] 3.2 Generate the ordered period list covering `[window.since, window.until]`,
      clamping the first `start` to `since` and the final `end` to `until`, and guarantee
      each entry's `end` equals the next entry's `start`.
- [ ] 3.3 Partition scanned runs into periods by resolved `startAt` using half-open
      `[start, end)` intervals, with the final period also admitting a run at exactly
      `until`.
- [ ] 3.4 Reduce each period's runs with the extracted reducer to produce `{ start, end,
      totals, metrics }`; keep diagnostics window-level only.

## 4. Output

- [ ] 4.1 Add optional `bucket` and `series` keys to `ScoreboardReport`, emitted only when
      a bucket was requested; leave `schema_version` at `1`.
- [ ] 4.2 Extend `formatScoreboardHuman()` with a per-period section rendering each entry
      in chronological order, including empty periods, after the full-window summary.

## 5. Tests

- [ ] 5.1 Day-bucket boundary alignment and contiguity over a multi-day window.
- [ ] 5.2 Week-bucket alignment to Monday `00:00:00.000Z`, with first/last periods clipped
      to the window bounds.
- [ ] 5.3 Run landing exactly on a period boundary is counted once, in the later period;
      run at exactly `until` lands in the final period.
- [ ] 5.4 Sum of series `totals.included_runs` equals the window's `totals.included_runs`.
- [ ] 5.5 Empty period reports zeroed totals, `ratio: null`, and `avg_ms: null` without
      throwing.
- [ ] 5.6 Window `window`/`totals`/`metrics`/`diagnostics` identical with and without
      `--bucket` for the same fixture.
- [ ] 5.7 Human output renders a per-period section in chronological order including empty
      periods; no such section without `--bucket`.
- [ ] 5.8 `--bucket month` throws an error naming `day` and `week` and produces no report.
- [ ] 5.9 CLI/registry tests: `--bucket` is an accepted `scoreboard` flag and appears in
      `scoreboard --help`.

## 6. Docs, mirror, gate

- [ ] 6.1 Document `--bucket day|week` in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`.
- [ ] 6.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 6.3 Run `npm run ci` from the repo root and confirm it is green.
