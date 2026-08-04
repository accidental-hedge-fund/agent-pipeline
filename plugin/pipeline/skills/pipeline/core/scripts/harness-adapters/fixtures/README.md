# Harness adapter telemetry fixtures (#778 / #653 shared corpus)

Recorded machine-readable CLI envelopes used to verify `parseTelemetry`
implementations. **Fixtures are the CI source of truth** (golden rule 5) —
flag existence in CLI help alone does not justify declaring
`telemetry: "jsonl"`.

| Adapter | Path | Mode | Recovered fields |
| --- | --- | --- | --- |
| claude | `claude/stream-json-result.jsonl` | stream-json | text, cost, usage, resolvedModel (modelUsage), throttled |
| codex | `codex/exec-json.jsonl` | exec --json | text, usage (no cost / resolvedModel / throttled) |
| grok | `grok/output-format-json.json` | --output-format json | text, cost, usage, resolvedModel (modelUsage) |
| grok | `grok/streaming-json-end.jsonl` | --output-format streaming-json | text (type:text), cost/usage/model on type:end |
| pi | _(none)_ | — | disposition: telemetry none (no verified fixture) |
| opencode | _(none)_ | — | disposition: telemetry none (no verified fixture) |

Production invoke uses the same `parseTelemetry` functions as evals (#653).
Engine/discovery SHA stamping is out of scope (#763).

Secrets in fixtures are markers (`SECRET-*`) so tests can assert they are
never persisted into stage accounting.
