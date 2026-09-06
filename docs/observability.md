# Fleet observability

Pipeline can hand metadata-only accounting to a host-local exporter for Langfuse.
Install the fleet agent-observability service and its machine-local
`~/.config/agent-observability/config.json` to enable this integration. There
are no network calls or Langfuse credentials in pipeline. `AGENT_OBSERVABILITY_ENABLED=0`
disables it immediately; `1` explicitly enables it. Configuration presence with
`enabled: false` also disables it.

Each completed invocation writes one immutable event to
`~/.local/state/agent-observability/inbox/` (override with
`AGENT_OBSERVABILITY_INBOX`). The inbox refuses new records after 10,000 files;
the source accounting remains in the run's `events.jsonl`. Export failures warn
without changing stage outcomes. The host exporter owns durable delivery,
retention, pricing, and health reporting.

The event carries `workload=agent-pipeline`, canonical repository/issue,
run/stage/invocation identity, loop identity when dispatched by `pipeline loop`,
resolved model when observed, usage, reported/estimated cost provenance, and
outcome. Missing usage remains absent. Requested models are metadata, not
substituted for resolved models. Reported CLI costs are not claimed as invoices.
Invocation ids distinguish retries; native harness session ids stay separate.

Pipeline invocation aggregates own pipeline token/cost accounting. Native
transcript observations provide the detailed timeline but must omit billable
usage/cost when their sidecar has `metadata.accounting_owner=pipeline`. Exporters
join `context/<harness>--<native_session_id>.json` before classifying workload.
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
options rather than mutating the parent environment. Existing Herdr integrations
are unaffected. Disabling the integration stops new writes; keep queued events
and sidecars until delivery or an explicit operator disposition. Rolling back
the code does not delete source accounting or fleet state.
