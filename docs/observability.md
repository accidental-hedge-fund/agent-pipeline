# Provider-neutral observability

Pipeline optionally exports metadata-only stage accounting to local files. A
separate collector can forward those files to Langfuse or another analytics
system. Pipeline has no backend SDK, endpoint, credentials, or telemetry network
calls. Installing a collector does **not** enable the product feature.

Explicitly opt in per repository in `.github/pipeline.yml`:

```yaml
observability:
  enabled: true
  traffic_class: real
  execution_purpose: operational
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

`traffic_class` is `real` (default), `synthetic`, or `unknown`.
`execution_purpose` is `operational` (default), `test`, `evaluation`,
`verification`, or `unknown`. These are independent: an evaluation that makes
paid provider requests is **real/evaluation**. A mocked fixture is
**synthetic/test**; its fake tokens/cost never leave the pipeline exporter.
Purpose alone never removes real provider usage from accounting. Node's test
workers veto the default filesystem exporter even with enabled fixture YAML;
unit/integration tests must inject an isolated I/O seam. This veto cannot enable
the feature, and does not apply to ordinary CLI evaluation runs.

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

## Fleet semantics, metadata version 2

The file envelope remains `schema_version: 1`; additive metadata records
`telemetry_schema_version: 2`. Invocation aggregates explicitly carry
`record_grain=invocation_aggregate`, an authoritative accounting role,
`timing_quality=aggregate`, traffic class/purpose, and an attempt identity.
Available token buckets are not proof of exhaustive source accounting;
`usage_completeness=unknown` remains explicit. Never count these aggregate rows
as individual provider requests. Synthetic aggregates are lifecycle-only and
supplementary, without usage or cost.

`job_session_id` joins invocations and physical resumed runs using the existing
immutable `logical_operation_id` when available; otherwise it uses the physical
run ID. Native session IDs and accounting event IDs remain unchanged. Consumers
may build a shared job session without rewriting historical trace identity.

Ordinary advance runs project durable `run_start`, `stage_start`,
`stage_complete`, and `run_complete` evidence into cost-free lifecycle records.
Advance-only train runs also export their run lifecycle. CLI invocations export
a cost-free `invocation_start` before spawn, then their final aggregate. A start
is evidence of admission, not proof that work is still running; no heartbeats
or active-job guarantee is supplied. Merge-authorized train admission is not
changed by this instrumentation. Its run lifecycle is not yet wired to this
optional exporter.

Lifecycle metadata includes `telemetry_event`, `lifecycle_phase`, known final
state/outcome, and stage attempt identity. Completed stages have measured timing
only when their matching start was observed in the same dispatcher. A resumed
completion without that evidence has unknown timing/attempt identity. No retry
ordinal is invented. Unknown/unrecognized outcomes stay unknown. Lifecycle
export runs only after durable source-event delivery; failure never changes
the stage outcome or source durability result.

Direct HTTP executors retain actual response status, retry count and rate-limit
evidence on failures as well as successes. Bounded failure categories distinguish
authentication, quota exhaustion, rate limiting, provider unavailability,
timeouts, cancellation, other errors, and unknowns. CLI stderr is not parsed or
exported to guess an HTTP status. This identifies known failures, not remaining
quota or provider invoice balances.

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
