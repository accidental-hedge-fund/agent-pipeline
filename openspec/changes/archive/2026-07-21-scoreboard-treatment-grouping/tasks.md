## 1. Record the effort identity (enabling change)

- [x] 1.1 Add an optional `effort` field to `StageAccountingRecord` in
      `core/scripts/types.ts` and to `BuildStageAccountingRecordInput` in
      `core/scripts/accounting.ts`, documenting it as additive and optional.
- [x] 1.2 Populate it in `buildStageAccountingRecord()` from the input (normalized with the
      existing `cleanOptionalString()` helper, `null`/absent when unresolved), and bump
      `STAGE_ACCOUNTING_SCHEMA_VERSION` additively.
- [x] 1.3 Pass the already-resolved per-stage reasoning effort at each existing
      `buildStageAccountingRecord()` call site (planning, implementing, review, fix, intake,
      sweep) — no new resolution logic.
- [x] 1.4 Tests: a record built with a resolved effort carries it; one built without omits it;
      a pre-change record shape still parses unchanged.

## 2. Grouping option plumbing

- [x] 2.1 Add `ScoreboardGroupBy = "harness" | "model" | "effort" | "executor"` and an optional
      `by` field to `ScoreboardOpts`.
- [x] 2.2 Add `parseScoreboardGroupBy()`: `null` for an absent flag; throws naming all four
      dimensions for an unsupported value; throws stating that exactly one dimension is
      supported when the flag is supplied more than once. Call it before any artifact scanning.
- [x] 2.3 Add `--by <dimension>` to the `scoreboard` command in `core/scripts/pipeline.ts`
      (collected repeatably so a duplicate can be detected, not silently last-wins), thread it
      into the early `scoreboard` dispatch, and extend the `scoreboard --help` usage line.
- [x] 2.4 Add `by` to the `scoreboard` entry's `allowedFlags` in
      `core/scripts/command-registry.ts`.

## 3. Identity resolution and the group reducer

- [x] 3.1 Implement `resolveGroupIdentity(record, dimension)`: verbatim non-empty value;
      `unknown` when the field is absent or empty; `not applicable` when the dimension cannot
      apply (executor dimension on a record with no executor evidence).
- [x] 3.2 Reduce the already-normalized accounting records into one group per identity value,
      accumulating the existing `CostAccountingTotals` fields plus per-group actual/estimated/
      unknown call counts and an `actual_coverage` that is `null` at zero calls.
- [x] 3.3 For the executor dimension, collect the distinct `executor_model` values observed in
      each group as a detail list.
- [x] 3.4 Sort groups by descending `invocation_count`, then by key ascending.
- [x] 3.5 Compute grouping inside the per-window reducer so `--bucket` series entries get it
      for free.

## 4. Output

- [x] 4.1 Add optional `by` and `grouping` keys to `ScoreboardReport` and to
      `ScoreboardPeriod`, emitted only when `--by` was supplied; leave `schema_version` at `1`.
- [x] 4.2 Extend `formatScoreboardHuman()` with a grouping section rendering one labelled
      line-group per identity in the reducer's order, including `unknown` and `not applicable`,
      and showing each group's cost provenance.

## 5. Tests

- [x] 5.1 `--by harness` produces one group per distinct recorded harness with correct
      invocation counts.
- [x] 5.2 `--by model`, `--by effort`, `--by executor` each produce the same entry shape for
      their dimension.
- [x] 5.3 Conservation: summed group `invocation_count`, `actual_cost_usd`, and
      `estimated_cost_usd` equal `cost_accounting.totals` for the same window.
- [x] 5.4 A record with an absent/empty identity lands in `unknown` and is not merged into a
      real value.
- [x] 5.5 Executor dimension: a local-harness record lands in `not applicable`, a delegated
      record with no provider lands in `unknown`, and both groups coexist distinctly.
- [x] 5.6 Harness/executor distinctness: a delegated record groups under its `harness` value
      with `--by harness` and under its `executor_provider` value with `--by executor`.
- [x] 5.7 Cost provenance preserved per group: actual/estimated/unknown call counts, and
      `actual_coverage: null` for a zero-call group.
- [x] 5.8 `--by harness --bucket day` emits a `grouping` object per series entry, conserving
      that period's `cost_accounting.totals`.
- [x] 5.9 No `--by`: JSON key set and values identical to the pre-change report; no human
      grouping section.
- [x] 5.10 `--by team` throws an error naming `harness`, `model`, `effort`, `executor`, and
      produces no report; a repeated `--by` throws stating one dimension only.
- [x] 5.11 Pre-change records (no `effort` field) group as `unknown` under `--by effort`.
- [x] 5.12 CLI/registry tests: `--by` is an accepted `scoreboard` flag and appears in
      `scoreboard --help`.

## 6. Docs, mirror, gate

- [x] 6.1 Document `--by harness|model|effort|executor` in `hosts/claude/SKILL.md` and
      `hosts/codex/SKILL.md`, including the `unknown` vs `not applicable` distinction.
- [x] 6.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 6.3 Run `npm run ci` from the repo root and confirm it is green.
