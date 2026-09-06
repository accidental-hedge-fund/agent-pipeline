# Provider-neutral observability

Pipeline optionally exports metadata-only stage accounting to local files. A
separate collector can forward those files to Langfuse or another analytics
system. Pipeline has no backend SDK, endpoint, credentials, or telemetry network
calls. Installing a collector does **not** enable the product feature.

Explicitly opt in per repository in `.github/pipeline.yml`:

```yaml
observability:
  enabled: true
  exporter:
    type: file
    directory: ~/.local/state/agent-pipeline/observability
```

All feature configuration lives here. `enabled` defaults to `false`; `file` is
the only supported exporter. The default directory shown above can be omitted.
It must be an absolute POSIX path or begin with `~/`, expanded using the current
host user's home. Environment-variable interpolation is not supported. The
legacy `AGENT_OBSERVABILITY_ENABLED`, `AGENT_OBSERVABILITY_INBOX`, and host
`~/.config/agent-observability/config.json` no longer enable, disable, or redirect
pipeline export. `pipeline config validate` checks this configuration, and
`pipeline config schema` describes its fields. The loaded configuration is
passed to CLI invocations, their retries/fallbacks, and direct API executors;
there is no per-invocation YAML reparse.

Every completed invocation already recorded as `stage_accounting` writes one
event to `<directory>/inbox/`. This includes tracked CLI and direct API stages
and command-gate lifecycle records. Commands without a run accounting context
do not gain synthetic run identities or historical data just by opting in.
The inbox refuses new records after 10,000 files; source accounting remains in
the run's `events.jsonl`. Writes use private directories/files (0700/0600),
temporary files, fsync, and atomic rename. Export failures warn without changing
stage outcomes. The independent collector owns acknowledgment/removal, network
delivery, deduplication, retention, pricing, and delivery health reporting.

## File contract, version 1

Both accounting files and native-session context sidecars carry
`schema_version: 1` and `producer: agent-pipeline`. Consumers must reject
unsupported schema versions, tolerate additional fields within a supported
version, and never infer token counts or prices from missing fields. Accounting
filenames are SHA-256 hashes of `event_id`, suffixed `.json`. Files contain one
UTF-8 JSON object followed by a newline. Temporary `.tmp` files are incomplete
and must be ignored. Multiple repositories can share the same host-local spool.

The event carries `workload=agent-pipeline`, canonical repository/issue,
run/stage/invocation identity, loop identity when dispatched by `pipeline loop`,
resolved model when observed, usage, reported/estimated cost provenance, and
outcome. Missing usage remains absent. Requested models are metadata, not
substituted for resolved models. Reported CLI costs are not claimed as invoices.
Invocation ids distinguish retries; native harness session ids stay separate.
The stable `event_id` identifies a completed invocation (`pipeline:<id>`).
Consumers must deduplicate retries of delivery by host and `event_id`, not by
timestamp. `session_id` is an explicitly synthetic invocation grouping, not a
native agent session. `kind` is `generation` when usage or cost is present and
`session` for lifecycle-only records. Input tokens include cache reads/writes;
output tokens include reasoning. Cache/reasoning counts are subsets, not extra
tokens to add again. Prompt text, responses, request payloads, command text,
tool arguments, and credentials are not part of this export contract.

## Exact native-session attribution

Pipeline invocation aggregates own pipeline token/cost accounting. Native
transcript observations provide the detailed timeline but must omit billable
usage/cost when their sidecar has `metadata.accounting_owner=pipeline`. Exporters
join `<directory>/context/<harness>--<native_session_id>.json` before classifying workload.
Claude uses `claude-code`; other built-ins use `codex`, `grok`, and `omp`.

An `active--<invocation_id>.json` marker exists before child spawn, with
`harness`, `start_time`, `cwd`, `pid` and attribution `metadata`. The exporter
must defer unmatched native sessions of that harness starting during the active
interval, so a transcript cannot be exported as interactive before its mapping
arrives. Mapping is written from initial stdout envelopes and checked again at
completion. Successful mapping retires the marker. Missing identity leaves
`unresolved: true` and `end_time`; the exporter must report this in health and
keep affected sessions deferred rather than silently billing them twice.

Child context is independent of `papercuts.enabled` and is passed through spawn
options rather than mutating the parent environment. `PIPELINE_RUN_ID`,
`PIPELINE_STAGE`, `PIPELINE_ISSUE`, `PIPELINE_HARNESS`, `PIPELINE_INVOCATION_ID`,
and (when known) `PIPELINE_REPO` carry runtime identity, not feature configuration.
`AI_OBSERVABILITY_WORKLOAD=agent-pipeline` and
`AI_OBSERVABILITY_ACCOUNTING_OWNER=pipeline` communicate ownership; the earlier
`AGENT_OBSERVABILITY_*` identity aliases remain for consumer compatibility.
Existing Herdr integrations are unaffected.

## Disable, migrate, or roll back

Set `observability.enabled: false` in `pipeline.yml` to stop new invocation
exports on subsequent config loads. Already-running invocations finish using
the configuration with which they started. Keep queued events and sidecars
until delivery or an explicit operator disposition. Rolling back code does not
delete source accounting or collector state.

For an existing collector reading `~/.local/state/agent-observability`, either
configure it to read the new default spool, or explicitly use that old directory
in `pipeline.yml`. Drain or retain the previous spool before changing paths.
Neither option requires a Langfuse-specific product configuration. Historical
imports are a separate, explicitly authorized collector operation and do not
implicitly opt repositories into future telemetry.
