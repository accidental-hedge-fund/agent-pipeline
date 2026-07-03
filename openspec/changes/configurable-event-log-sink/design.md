## Context

Every run event flows through a single chokepoint: `appendEvent(runDir, event, deps)` in
`core/scripts/run-store.ts`. It serializes the event to a JSON line, appends it to
`events.jsonl` via `deps.appendFile` (O_APPEND, non-fatal on error), and — when
`deps.stdoutWrite` is set (`--json-events` mode) — mirrors the same line to stdout. Text
fields are already screened by the injection denylist and secret redaction before the line
is formed. This single seam is where an external sink must attach, so that **all** event
producers (stage lifecycle, `review_verdict`, `stage_accounting`, `human_intervention`, gh
metrics, etc.) reach the sink without touching each call site.

`RunStoreDeps` is already the injectable I/O seam used by unit tests (in-memory fakes, no
real network/git/subprocess). The sink must be reachable through the same seam so it can be
tested with a fake and so a missing sink adds zero behavior.

## Goals / Non-Goals

**Goals**
- Opt-in external event delivery configured in `pipeline.yml` or an env var, no code change.
- One attach point (`appendEvent`) so every event type is covered uniformly.
- Non-fatal delivery consistent with the run-store's existing local-I/O error handling.
- Preserve today's behavior exactly when unconfigured.

**Non-Goals**
- Vendor-specific clients, HTTP/retry/backoff policy, or credential management (the operator
  owns the forwarder command and its auth).
- Buffering/durability guarantees beyond best-effort ordered delivery.
- Any change to event shape or `schema_version`.

## Decisions

### Decision: The sink is an operator-supplied forwarder command, not an embedded HTTP client
Aggregators differ (Datadog agent, CloudWatch agent, `logger`, `vector`, `curl` to Loki,
Splunk HEC). Embedding one client pulls in vendor specifics, auth, and retry policy — exactly
the over-engineering that sank #319. A **command** sink is maximally portable: the operator
provides a command (e.g. `logger -t pipeline`, or a small script that POSTs to their endpoint);
the pipeline delivers each event line to it. Auth "beyond what the operator provides" stays out
of scope because the operator's command carries its own credentials.

- **Alternative considered — a built-in HTTP sink (`url:` + headers):** rejected for this slice.
  It forces the engine to own ret/backoff, TLS, and header/secret handling, and still would not
  cover the CLI-agent aggregators. An operator who wants HTTP writes a one-line `curl` command.
  A future change may add an HTTP sink type on top of this seam if demand is real.

### Decision: Delivery attaches at `appendEvent` via a `RunStoreDeps` seam
Add an optional `eventSink?: (line: string) => void | Promise<void>` (best-effort) to
`RunStoreDeps`, wired in `pipeline-run.ts` alongside the existing `stdoutWrite` wiring. When
present, `appendEvent` delivers the already-serialized line to it. When absent, `appendEvent`
is unchanged. This mirrors the existing `stdoutWrite` pattern exactly and keeps every event
producer oblivious to the sink.

### Decision: `mode` gates the local write, not the sink
- `additive` (default): local `events.jsonl` append happens as today **and** the line is
  delivered to the sink. Safer for rollout — the operator keeps a local copy while validating
  their aggregator wiring.
- `exclusive`: the local `events.jsonl` append is skipped; only the sink receives the line.
  For truly ephemeral runners where the local file is worthless. The write-once `run.json`,
  `terminal.log`, and `summary.json` are **not** affected — only the `events.jsonl` stream is
  redirected, keeping the change surgical.

Default is `additive` because losing events silently (exclusive + a misconfigured sink) is the
worse failure mode; the operator opts into exclusivity deliberately.

### Decision: Sink delivery is non-fatal and never blocks or corrupts the local write
Delivery is wrapped so any throw/rejection/non-zero exit is caught and surfaced as a single
`console.warn` (same `[pipeline] run-store:` non-fatal convention already used for
`appendEvent`/`initRunDir`/`finalizeRun` failures). In `additive` mode the local append runs
first and is independent of sink outcome, so a broken sink can never drop or corrupt a local
line. In `exclusive` mode a sink failure means that event is not persisted anywhere — an
accepted consequence of the operator's explicit choice, matching the run-store's existing
best-effort contract.

### Decision: Config lives in a strict `event_sink` block with env-var overrides
Follows the established per-feature block pattern (`test_gate`, `eval_gate`, `openspec`) —
a `.strict()` zod object so unknown keys fail fast:

```yaml
event_sink:
  command: "logger -t pipeline"   # operator-controlled forwarder; receives event JSON lines
  mode: additive                  # additive (default) | exclusive
```

Environment overrides (matching the `PIPELINE_PROFILE` precedent) let ephemeral runners set
the sink without editing a checked-in file: `PIPELINE_EVENT_SINK_COMMAND` and
`PIPELINE_EVENT_SINK_MODE`. Env overrides win over file config, consistent with CLI-over-file
precedence. When neither the block nor the env var supplies a `command`, no sink exists and
behavior is unchanged.

## Risks / Trade-offs

- **Exclusive + broken sink loses events.** Mitigated by defaulting to `additive` and by
  documenting the trade-off; `pipeline logs --events` naturally has nothing to read in
  exclusive mode, which is the expected, documented outcome.
- **Sink latency could slow the run.** Delivery is best-effort and should not block the local
  append; a slow command is the operator's responsibility. Implementation keeps delivery off
  the critical path of the local write.
- **Secret exposure via the sink.** Neutralized by attaching at `appendEvent` *after* the
  existing injection-denylist screen and secret redaction — the sink can only ever see the
  same bytes already written to `events.jsonl`.

## Migration

None. The feature is additive and opt-in; existing configs, runs, and `pipeline logs`
invocations are unaffected. No data migration, no schema bump.
