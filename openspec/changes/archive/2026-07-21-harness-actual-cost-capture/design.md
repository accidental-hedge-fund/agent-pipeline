# Design — harness actual-cost capture

## Verified external shapes

Golden rule #5: these were confirmed against the installed CLIs, not assumed.

`claude --print --verbose --output-format stream-json --include-partial-messages`
emits one JSON object per line; the terminal line is:

```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":2689,
 "result":"Hi! …","session_id":"683a0497-…","total_cost_usd":0.0014383,
 "usage":{"input_tokens":10,"cache_creation_input_tokens":0,
          "cache_read_input_tokens":8133,"output_tokens":123, …},
 "modelUsage":{"claude-haiku-4-5-20251001":{"costUSD":0.0014383, …}}}
```

Notes: `--output-format stream-json` **requires** `--verbose` under `--print` (the CLI
errors out otherwise). Incremental assistant text arrives as `{"type":"stream_event",
"event":{...}}` lines. `--output-format json` (non-stream) carries the same
`total_cost_usd`/`usage`/`result` fields but emits nothing until the call finishes.

`codex exec --json` emits:

```json
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}
{"type":"turn.completed","usage":{"input_tokens":14230,"cached_input_tokens":10496,
                                  "output_tokens":5,"reasoning_output_tokens":0}}
```

**No cost field.** Codex therefore yields actual *tokens* but never an actual *cost*.

## Decision 1 — stream-json, not json

`invoke()` streams harness output to the terminal by default (`stream: true`), and long
review/fix rounds depend on that live visibility. Non-stream `json` would buy simpler
parsing at the price of a silent terminal for the whole call — a rigor/observability
regression, so it is rejected.

With `stream-json` the harness layer becomes a small translator: capture the JSONL,
forward only the human-meaningful assistant text to the terminal, and keep the raw
JSON out of the operator's view.

## Decision 2 — `stdout` stays plain text

Every existing consumer treats `HarnessResult.stdout` as the harness's textual answer
(`parseStructuredVerdict`, fix-round output, gate output). The telemetry envelope is an
implementation detail of the transport, so after a telemetry-mode call the harness layer
sets `stdout` to the reconstructed final assistant text (claude: the `result` field;
codex: the last `agent_message` item text). No call site changes, and the existing
verdict/fix tests keep passing unmodified — that is the regression guard for this
decision.

## Decision 3 — fail open, never fail the stage

Telemetry is observational (`stage-cost-accounting`: "Accounting data is observational
and does not affect routing"). If the envelope is missing, truncated (timeout/kill), or
unparseable:

- the raw captured output is returned as `stdout` (better a raw blob than nothing),
- the outcome/exit-code semantics are untouched,
- the record falls back to `cost_source: "unknown"`, `cost_usd: null`.

A kill-switch env var (`PIPELINE_HARNESS_TELEMETRY=off`) restores the pre-change
plain-text argv. It is an escape hatch, not a config surface: no `pipeline.yml` key, so
nothing new to validate, document, or default-demote.

## Decision 4 — no price table

Codex reports tokens but no cost. Multiplying tokens by a hard-coded per-model price
would produce a number indistinguishable from a measurement while being a guess whose
accuracy silently rots as prices change. Codex cost stays `estimated` (operator's
`--estimate-cost`) or `unknown`. The recorded token counters make a *future*, explicit
estimator possible without pretending now.

## Decision 5 — additive schema bump with tolerant reads

`STAGE_ACCOUNTING_SCHEMA_VERSION` goes `1 → 2`. Version 2 adds no required field and
removes none; it signals "this record's `cost_source` may be `actual` from harness
telemetry". Readers (`scoreboard.ts`, `queue.ts`, summary) must not compare
`schema_version` for equality — a mixed v1/v2 window aggregates without diagnostics.
A test asserts a v1 record still aggregates after the bump.

## Decision 6 — coverage, not just totals

`accountingSummary` already totals actual/estimated USD and an unknown count. Coverage
answers a different question — *how much of this window is measured?* — so the
scoreboard adds explicit per-source call counts plus
`actual_coverage = actual_calls / total_calls`, `null` when `total_calls` is `0`
(matching the existing "zero denominator ⇒ `null`, never `0`" rule).

## Privacy

The envelope contains far more than the allowlist permits (`session_id`, `uuid`, full
assistant text, rate-limit info). Extraction stays allowlist-only via the existing
`extractUsageAccounting` path: numeric token counters, numeric cost, harness/model
identifiers, timestamps. `session_id`, `uuid`, `parent_tool_use_id`, `result` text, and
rate-limit objects are never persisted into an accounting record.

## Testing seams

`runCapped` already accepts an injectable `spawnFn` and a `forwardTo` pair (#384). The
envelope parser is a pure function over captured JSONL text, unit-tested directly with
recorded fixture lines (real shapes above) — no network, git, or subprocess, per repo
convention. Fixtures cover: claude success, codex success, truncated final line, and
non-JSON noise interleaved with envelope lines.
