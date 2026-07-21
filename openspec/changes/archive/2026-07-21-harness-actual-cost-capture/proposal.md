# Capture actual per-call cost from harness output

## Why

`stage_accounting` already carries `cost_source` (`actual` | `estimated` | `unknown`)
and `buildStageAccountingRecord` already knows how to classify an actual cost — but
nothing ever feeds it one. `invoke()` in `core/scripts/harness.ts` accepts
`accounting.usage`, and no call site populates it, because the built-in harnesses are
invoked in plain-text output mode (`claude --print --output-format text`,
`codex exec --full-auto`) where per-call telemetry is not emitted at all.

The practical result: every local harness call lands as `cost_source: "unknown"`, and
the only cost figure the factory scoreboard can produce is an operator guess supplied
at report time via `--estimate-cost <harness>=<usd>`. Maintainers cannot tell whether
the cost line in a scoreboard is measured or invented, and cannot see how much of the
window is measured at all.

Both supported harnesses do expose this telemetry in a machine-readable output mode
(verified against the installed CLIs, not assumed):

- `claude --print --verbose --output-format stream-json --include-partial-messages`
  emits a terminal `{"type":"result", ...}` line carrying `total_cost_usd`, a `usage`
  object (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`), and the final assistant text in `result`.
- `codex exec --json` emits `{"type":"turn.completed","usage":{...}}` carrying
  `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`
  — **token counts only, no cost field**.

So Claude calls can be measured end-to-end; Codex calls can be measured for tokens but
their cost legitimately stays `estimated` or `unknown`. This change wires that
telemetry into the accounting record and reports coverage so the distinction is visible.

## What Changes

- Invoke the built-in harnesses in their machine-readable output mode and parse a
  per-call telemetry envelope from the captured stream, while preserving both the
  live terminal streaming operators rely on and the plain-text `stdout` every existing
  caller parses (verdict JSON, fix output, gate output).
- Populate `accounting.usage` from that envelope so `buildStageAccountingRecord`
  classifies real measured cost as `cost_source: "actual"`, and persist the sanitized
  numeric token counters alongside it.
- Keep operator-supplied values at `cost_source: "estimated"` and absent values at
  `cost_source: "unknown"` with `cost_usd: null` — never `0`.
- Bump `STAGE_ACCOUNTING_SCHEMA_VERSION` to `2` additively; readers (scoreboard,
  queue, summary) continue to accept version-`1` records unchanged.
- Add cost-source **coverage** (actual / estimated / unknown call counts and the
  actual-coverage ratio) to both the human and `--json` scoreboard output.
- Provide an environment kill-switch that restores the previous plain-text invocation
  if the telemetry mode ever misbehaves, degrading to `cost_source: "unknown"` rather
  than failing a stage.

## Acceptance Criteria

- [ ] A `claude` harness call made through `invoke()` with accounting enabled emits a
      `stage_accounting` event with `cost_source: "actual"` and `cost_usd` equal to the
      `total_cost_usd` reported by the CLI for that call.
- [ ] The same event carries a sanitized `usage` object with the CLI-reported token
      counters, and contains no prompt text, response text, transcript, session id, or
      usage-log path.
- [ ] A `codex` harness call records its reported token counters in `usage`, and —
      because `codex exec --json` reports no cost — records `cost_source: "estimated"`
      when an operator estimate applies and `cost_source: "unknown"` with
      `cost_usd: null` otherwise.
- [ ] `HarnessResult.stdout` for a telemetry-mode call equals the harness's final
      assistant text, so every existing consumer (verdict parsing, fix rounds, gates)
      behaves identically to the plain-text mode.
- [ ] With streaming enabled, assistant output still reaches the terminal as it
      arrives; raw telemetry JSON lines are not dumped to the operator's terminal.
- [ ] When the telemetry envelope is missing, truncated, or unparseable, the call still
      returns its captured output, the stage outcome is unchanged, and the record falls
      back to `cost_source: "unknown"` with `cost_usd: null`.
- [ ] Every newly written `stage_accounting` event has `schema_version: 2`, and the
      scoreboard aggregates a mixed set of version-`1` and version-`2` records without
      diagnostics or dropped records.
- [ ] `pipeline scoreboard --json` exposes cost-source coverage counts
      (`actual`, `estimated`, `unknown`) and an actual-coverage ratio that is `null`
      when there are no calls; the human report prints the same coverage line.
- [ ] `--estimate-cost <harness>=<usd>` syntax, precedence (actual beats estimate), and
      all budget/queue gating behavior are unchanged, proven by existing tests still
      passing unmodified.

## Impact

- Affected specs: `stage-cost-accounting`, `factory-scoreboard`
- Affected code: `core/scripts/harness.ts` (invocation args + envelope parsing +
  accounting wiring), `core/scripts/accounting.ts` (schema version),
  `core/scripts/scoreboard.ts` (coverage reporting), `core/scripts/types.ts`,
  plus the regenerated `plugin/` mirror.

## Out of Scope

- Adding telemetry to harnesses or executors that do not expose it (custom
  `review_harness` CLIs, external stage executors, subprocess gate records).
- Deriving cost from token counts via a built-in price table — that would be an
  estimate wearing an `actual` label.
- Changing budget thresholds, gating, or the `--estimate-cost` syntax.
- Historical backfill of already-written run artifacts.
- Dashboards, hosted reporting, or any organization billing / chargeback integration.
