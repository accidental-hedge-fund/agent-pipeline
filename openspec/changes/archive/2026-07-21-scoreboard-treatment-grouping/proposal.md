## Why

`pipeline scoreboard` already records a treatment identity on every harness call —
`stage_accounting` records carry `harness`, `model`, `model_slot`, and (for delegated
stages) `executor_provider`/`executor_model`. But the report only exposes those
identities through `cost_accounting.groups`, a fixed six-key grouping
(`issue × stage × harness × model_slot × model × outcome`) that is too fine-grained to
answer the maintainer's actual question: *"how do my claude runs compare to my codex
runs?"*, or *"what did switching the implementing model cost me?"*. Today that requires
hand-reducing the JSON groups externally.

This change adds an opt-in `--by <dimension>` flag that collapses the existing
record-scoped metrics along **one** generic execution-identity dimension. It is
descriptive inspection of a maintainer's own local runs — no new datasets, no export, no
scoring, no ranking.

## What Changes

- `pipeline scoreboard` gains an optional `--by harness|model|effort|executor` flag.
- When supplied, the report gains an additive `grouping` object: the selected dimension
  plus one entry per observed identity value, each carrying the record-scoped metrics the
  report already computes (invocation count, duration totals, command/subprocess counts,
  prompt-size totals, and full actual/estimated/unknown cost provenance with coverage).
- Exactly one dimension is accepted per invocation. A repeated `--by` or an unsupported
  value fails with a clear error naming the supported dimensions, before any artifact is
  read and before any report bytes are written.
- Identity values are never coerced. A record missing the selected identity groups under
  the literal key `unknown`; a record for which the dimension cannot apply (e.g. the
  executor dimension for a stage that ran on the local harness) groups under the literal
  key `not applicable`. Neither key is merged into the other, and neither is dropped.
- Harness identity and executor identity stay distinct: `harness` groups on the record's
  `harness` field verbatim (which, for a delegated stage, is the configured *executor
  name*), while `executor` groups on `executor_provider` (with `executor_model` reported
  as a detail). A local-harness record is `not applicable` under `executor` and keeps its
  real harness name under `harness`.
- Grouping composes with `--bucket day|week`: each series entry gains its own `grouping`
  computed from that period's runs only, using the same shapes.
- **`--by effort` requires an additive record field.** Reasoning effort is resolved per
  stage (`effort.planning`/`implementing`/`fix`/…, `#366`) and passed to the harness, but
  it is *not* currently persisted on `StageAccountingRecord`. This change adds an
  optional `effort` field to that record, written from the already-resolved value. See
  design decision 5 — this deviates from the issue's "no new event fields" line, which is
  otherwise unsatisfiable alongside the `--by effort` acceptance criterion.
- Without `--by`, output is unchanged key-for-key: no `by` key, no `grouping` key, no new
  human section.

Non-goals: no run-scoped metric is split by treatment identity (see design decision 2);
no multi-dimensional cubes; no statistical comparison, significance, or ranking; no
organization-, team-, or person-oriented dimensions; no hosted analytics, no external
transmission, no recommendations; no change to default behaviour or to any existing
metric definition.

**Scope conflict surfaced (not averaged):** the issue's acceptance criterion "grouping
composes with … offline HTML export" names a surface that does not exist —
`core/scripts/scoreboard.ts` emits only human text and `--json`, and no HTML export
capability is specified anywhere in `openspec/specs/`. This change therefore specifies
composition with the surfaces that do exist (`--json` and `--bucket`) and guarantees the
grouping payload is a plain additive JSON structure that any future export renderer can
consume without a shape change. It does **not** invent an HTML exporter.

## Capabilities

### Modified Capabilities
- `factory-scoreboard`: adds the optional single-dimension `--by
  harness|model|effort|executor` flag, the identity-resolution rules (verbatim values,
  explicit `unknown` vs `not applicable`, harness/executor separation), per-group cost
  provenance, composition with `--bucket`, additive human/JSON output, validation of
  unsupported and repeated values, and the unchanged-by-default guarantee.
- `stage-cost-accounting`: records the resolved reasoning effort as an optional,
  additive `effort` field on `StageAccountingRecord` so the effort dimension has a
  recorded identity to group on.

## Impact

- `core/scripts/scoreboard.ts` — add `ScoreboardGroupBy` type and `by` option, a
  `parseScoreboardGroupBy()` validator, identity resolution per accounting record, the
  group reducer, additive `by`/`grouping` report keys, and human rendering
- `core/scripts/accounting.ts`, `core/scripts/types.ts` — optional `effort` on
  `BuildStageAccountingRecordInput` and `StageAccountingRecord`
- `core/scripts/stages/*.ts` — pass the already-resolved per-stage effort into the
  accounting record builder at existing call sites
- `core/scripts/pipeline.ts` — `--by <dimension>` CLI option, threading into the early
  `scoreboard` dispatch, extended `scoreboard --help` usage line
- `core/scripts/command-registry.ts` — add `by` to the `scoreboard` allowed-flag set
- `core/test/scoreboard.test.ts`, `core/test/accounting.test.ts`,
  `core/test/pipeline-cli.test.ts`, `core/test/command-registry.test.ts` — unit tests
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the flag
- `plugin/` — regenerated mirror (`node scripts/build.mjs`)

## Acceptance Criteria

- [ ] `pipeline scoreboard --json` invoked without `--by` produces a JSON object with
      exactly the same key set and values as before this change (no `by` key, no
      `grouping` key), and the human output contains no grouping section.
- [ ] `pipeline scoreboard --json --by harness` emits a `grouping` object whose `by` is
      `harness` and whose `groups` array contains one entry per distinct `harness` value
      observed across the window's accounting records.
- [ ] `--by model`, `--by effort`, and `--by executor` each emit a `grouping` object for
      their respective dimension using the identical entry shape.
- [ ] Every group entry carries `invocation_count`, duration totals, command/subprocess
      counts, prompt-size totals, `actual_cost_usd`, `estimated_cost_usd`,
      `unknown_cost_count`, and per-group actual/estimated/unknown call counts with an
      `actual_coverage` that is `null` when the group has zero calls.
- [ ] The sum of `invocation_count` across all groups equals the window's
      `cost_accounting.totals.invocation_count`, and the summed per-group
      `actual_cost_usd`/`estimated_cost_usd` equal the window totals — no record is
      dropped or double-counted.
- [ ] A record whose selected identity field is absent or empty appears under a group
      whose key is exactly `unknown`; it is not merged into any real identity value.
- [ ] Under `--by executor`, a record with no executor fields appears under a group whose
      key is exactly `not applicable`, while a delegated record with an executor but no
      recorded provider appears under `unknown`; the two groups are distinct and both may
      be present in the same report.
- [ ] For a run in which one stage was delegated to an external executor, `--by harness`
      groups that record under its recorded `harness` value and `--by executor` groups it
      under its `executor_provider` value; the two reports do not conflate the identities.
- [ ] `pipeline scoreboard --by harness --bucket day --json` emits a `grouping` object on
      each series entry computed only from that period's runs, and each period's group
      `invocation_count` sum equals that period's `cost_accounting.totals.invocation_count`.
- [ ] `pipeline scoreboard --by team` (or any unsupported value) exits non-zero with an
      error naming `harness`, `model`, `effort`, and `executor`, and writes no report to
      stdout.
- [ ] Supplying `--by` more than once in a single invocation exits non-zero with an error
      stating that exactly one dimension is supported, and writes no report to stdout.
- [ ] A `stage_accounting` record written after this change carries the stage's resolved
      reasoning effort as an `effort` field when one was resolved, and omits it (grouping
      as `unknown`) when none was; records written before this change remain readable and
      group as `unknown` under `--by effort`.
- [ ] Human output with `--by` renders one labelled line-group per identity value after
      the existing summary, in a deterministic order, including the `unknown` and
      `not applicable` groups.
- [ ] Unit tests cover each dimension, `unknown` vs `not applicable` separation,
      harness/executor distinctness, conservation of totals, provenance preservation,
      `--bucket` composition, unchanged no-`--by` output, and rejection of unsupported and
      repeated values — using the existing injected `ScoreboardDeps` seam with no real
      network, git, or subprocess calls.
