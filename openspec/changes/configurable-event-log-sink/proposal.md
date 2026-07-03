## Why

The pipeline writes every run event to a local `events.jsonl` under
`.agent-pipeline/runs/<run-id>/`. Teams running the pipeline in ephemeral or shared
environments lose that file when the runner's filesystem disappears, and teams with
existing centralized log infrastructure (Datadog, CloudWatch, Loki, Splunk) have no
way to route pipeline events into the same system as the rest of their operational
logs. Today the only way to get events off the local disk is to patch the engine.

The adjacent closed issue #319 (runner-neutral logging + artifact discovery) was
rejected as over-engineered for the current single-operator model. This change is the
narrow, concrete slice of that space: make the **event stream destination pluggable**,
without the artifact registry, runner-identity model, or GitHub evidence index that
made #319 too broad. It is strictly opt-in — an unconfigured pipeline behaves exactly
as it does today.

## What Changes

- Add an optional `event_sink` block to `.github/pipeline.yml` (with environment-variable
  overrides) that names an operator-controlled forwarder **command**. Each event that is
  appended to `events.jsonl` is also delivered to that command as the same JSON line.
- Add a `mode` selector (`additive` | `exclusive`, default `additive`) so the operator
  chooses whether events go to `events.jsonl` **and** the sink (additive) or **only** to
  the sink (exclusive).
- When no sink is configured, all existing local-file behavior is unchanged (byte-for-byte
  the same `events.jsonl`, same `--json-events` streaming, same `pipeline logs --events`).
- Sink delivery is non-fatal: an unreachable or erroring sink is caught, logged as a
  warning, and the run continues — consistent with how the run-store already treats local
  I/O errors. In additive mode a sink failure never affects the local write.
- The delivered records are the **same** structured, already-redacted event lines — no
  schema change, no new event types, `schema_version` stays `1`.

## Capabilities

### New Capabilities
- `configurable-event-sink`: an opt-in, operator-configured external destination that
  receives the run's `events.jsonl` records, with additive/exclusive mode selection and
  non-fatal delivery.

### Modified Capabilities
- None. The `events-jsonl-streaming`, `log-follow-command`, and `pipeline-configuration`
  capabilities are unchanged in intent; the new sink reuses their existing records and
  loader/precedence rules without altering them.

## Acceptance Criteria

- [ ] An operator can configure an external event destination entirely in
  `.github/pipeline.yml` (`event_sink.command`) or via an environment variable
  (`PIPELINE_EVENT_SINK_COMMAND`) — no code change and no engine patch required.
- [ ] With a sink configured in `additive` mode (the default), every event is written to
  the local `events.jsonl` **and** delivered to the sink; with `exclusive` mode, events are
  delivered to the sink and **not** written to `events.jsonl`.
- [ ] With **no** `event_sink` configured, `events.jsonl` content, `--json-events` stdout
  streaming, and `pipeline logs <run-id> --events` are byte-for-byte identical to current
  behavior.
- [ ] A sink that is unreachable or exits non-zero causes a non-fatal warning and the run
  continues to completion; in additive mode the local `events.jsonl` write is unaffected by
  the sink failure.
- [ ] The lines delivered to the sink are the same JSON records written to `events.jsonl`
  (identical content, already screened by the injection denylist and secret redaction),
  carry no new fields, and keep `schema_version: 1`.
- [ ] `pipeline logs <run-id> --events` continues to read the local `events.jsonl` whenever
  it is present, regardless of sink configuration.
- [ ] Invalid `event_sink` config (unknown key, wrong type, or `mode` outside
  `additive`/`exclusive`) fails `resolveConfig()` fast with a schema error, consistent with
  the rest of `pipeline.yml` validation.

## Out of Scope

- Built-in integrations with named aggregators (Datadog, CloudWatch, Loki, Splunk, …). The
  operator supplies their own forwarder command; the pipeline does not embed vendor clients.
- Any change to the events schema or the addition of new event types.
- Log retention, archival, or rotation policy at the external destination.
- A UI or query interface for browsing externally-stored events.
- Authentication or credential management beyond what the operator's command already carries
  (env, config, files the operator controls).
- Routing `terminal.log`, `run.json`, or `summary.json` off local disk — this change is
  scoped to the `events.jsonl` event stream only.
