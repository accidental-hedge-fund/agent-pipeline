# Design — fleet-telemetry-aggregation (#503)

## Context

Each Agent Pipeline repo writes its own `.agent-pipeline/runs/*` artifacts (`run.json`,
`events.jsonl`, `summary.json`). The `configurable-event-sink` capability (#343) can forward each
`appendEvent` line — already screened by the injection denylist and secret redaction — to a local
operator command in `additive` or `exclusive` mode. That is the only cross-boundary hook, and it
carries no shared identity, no durable delivery guarantee, no cross-repo aggregation, and no query
surface. This change designs the customer-controlled observability plane on top of that hook: a fleet
envelope, a durable authenticated delivery mode, a reference collector contract, read-only fleet
reporting, and documented governance. It is decision-complete and **intent-only** — no engine code
lands in this OpenSpec step.

## Goals / Non-goals

**Goals**
- One tenant-isolated control plane collecting sanitized telemetry from many repos/hosts.
- Stable fleet identity + per-run ordering on every event without leaking repo names or paths.
- At-least-once durable delivery that is non-fatal to any run and observably healthy.
- Cross-repo/host reporting that reuses the existing scoreboard/improve metrics and preserves lineage.
- Full backward compatibility with the current no-sink and `event_sink` behavior.

**Non-goals** (per issue "Out of scope")
- Sending customer fleet telemetry to Agent Pipeline maintainers.
- A mandatory hosted SaaS or vendor-specific logging integration.
- Raw terminal logs, prompts/model output, source, repository names, secrets, or arbitrary env capture.
- Cross-host mutation, locking, queue ownership, or any control-plane command channel — this is
  telemetry and read-only analysis only.

## Key decisions

### D1 — A separate opt-in `fleet` config block, not an `event_sink` schema change
The existing `event_sink` block is a **strict** schema of `command` + `mode`; adding delivery keys to
it would modify that requirement and risk regressing the additive/exclusive contract. Instead, fleet
delivery is a distinct, opt-in top-level `fleet` block (tenant/installation identity, collector
endpoint, scoped credential reference, spool + retry + overflow settings). `event_sink` stays exactly
as specified in #343 and remains usable independently. This keeps "forward a raw line to a local
command" and "authenticated durable delivery to a tenant collector" as separate, composable concerns,
and makes backward compatibility a structural property (no `fleet` block ⇒ no behavior change) rather
than a runtime guard.

### D2 — Reuse the sanitized `appendEvent` records; the envelope only wraps
The fleet envelope wraps the existing screened `events.jsonl` records verbatim (payload byte-identical
to what #343 delivers). It adds an envelope header only; it never re-derives or enriches the payload.
This guarantees the data-minimization posture is inherited from the existing screening (injection
denylist + secret redaction) and cannot silently regress, and it avoids a second evidence system.

### D3 — Pseudonymous, deterministic `repo_id` and `host_id`
`repo_id` is a stable pseudonymous identifier derived deterministically per installation (e.g. an
HMAC of a repo-stable value under an installation-scoped key) so the same repo maps to the same id
across runs and hosts, while the raw repository name and local path are excluded by default. Friendly
names are resolved **customer-locally** (a local mapping file or customer-controlled collector
metadata); the mapping is never part of the fleet payload and never reaches upstream maintainers.
`host_id` is likewise pseudonymous and stable per host.

### D4 — Per-run monotonic sequence for ordering; collector deduplicates
Each envelope carries a per-run monotonically increasing `seq`. Ordering is reconstructed at the
collector from `(run_id, seq)`, so out-of-order or duplicate delivery is tolerated without skewing
metrics. The idempotency key is deterministic — `(tenant, installation, run_id, seq)` (or an
event-content digest) — so the same event delivered twice deduplicates to one stored record.

### D5 — At-least-once durable delivery, non-fatal, with a bounded spool
Delivery treats the network as at-least-once. Envelopes are written to a durable **local spool** first,
then delivered with bounded retry/backoff; a delivery is retired from the spool only on a collector
acknowledgement. A sink outage never changes a stage outcome — delivery is best-effort relative to the
run, exactly like the #343 non-fatal contract — and the spool has an **explicit, bounded** overflow
policy (documented drop-oldest or back-pressure, never unbounded growth) that emits a diagnostic when
it engages. Delivery lag, drop counts, rejected-schema counts, and last successful acknowledgement are
exposed as machine-readable diagnostics.

### D6 — Scoped ingest credentials; tenant isolation is a collector invariant
Delivery authenticates with a **scoped** ingest credential bound to one tenant/installation. The
collector enforces that a credential can only write, and a query credential can only read, that
tenant's data — one tenant/installation can never write to or query another's. Credentials rotate and
revoke without editing repository configuration (the config references a credential, it does not inline
a long-lived secret).

### D7 — Collector validates, versions, and migrates forward-compatibly
The collector validates each envelope against the known schema, **rejects** malformed or
unsupported-major-version envelopes with a machine-readable reason, and **accepts** forward-compatible
optional fields (unknown optional fields tolerated, not fatal). An explicit migration policy governs
how envelope/schema versions evolve. The reference collector writes to **customer-owned** storage; the
contract is what matters, so a customer may deploy the reference collector or implement the contract
against their own store.

### D8 — Read-only fleet reporting reuses existing metrics and preserves lineage
Fleet reports are strictly read-only (no GitHub, worktree, config, or run-artifact mutation, mirroring
the `scoreboard`/`improve` read-only contract). They aggregate the **existing** scoreboard/improve
metrics across authorized repos/hosts and add fleet-level rollups (run counts, active/stale
installations, delivery health, top blocker/failure classes, correction recurrence when #499–#501
evidence exists). Every aggregated metric preserves **evidence lineage** back to the contributing
runs/events. Human and JSON output both support filter/group by pseudonymous repo, installation, host,
Pipeline version, stage, harness/model, outcome, and time window.

### D9 — Governance is customer-controlled and testable
Retention windows, tenant deletion, export, access audit, and credential rotation are specified as
collector-side, customer-controlled operations with observable, testable outcomes — not as prose
promises. They live on the customer's control plane; maintainers have no access path.

## Relationship to adjacent issues
- **#343** — reused: the sanitized, versioned records and the sink producer path are the substrate;
  its `event_sink` requirements are unchanged.
- **#459** — coordinated: tenant/installation/host identity is consistent with cross-host assumptions,
  but aggregation is **read-only** and never acts as a distributed lock or ownership authority.
- **#499–#501** — ingested unchanged: `correction_event` evidence flows into reports without altering
  its semantics; correction recurrence is reported only when that evidence is present.
- **#502** — disjoint: #502 reports probable *product* faults upstream to maintainers; this issue
  aggregates a customer's *own* fleet telemetry into that customer's control plane. No shared path.
- **#505** — complementary: #505 designs the control↔execution boundary and may *feed* sanitized
  health telemetry here; this capability never exposes a command channel back to execution.

## Risks / trade-offs
- **Over-collection creep.** Mitigated by D2 (envelope only wraps already-screened records) and a
  redaction test asserting repo name/path/prompt/secret/human-identity never appear in a payload.
- **Spool unboundedness.** Mitigated by D5's explicit, tested overflow policy and diagnostics — the
  spool is bounded by contract, and overflow is observable, never silent.
- **Duplicate-delivery metric skew.** Mitigated by D4 deterministic idempotency + collector dedup,
  proven by a dedup-does-not-double-count test.
- **Identity leakage via pseudonyms.** Mitigated by D3 (installation-scoped derivation, customer-local
  friendly-name mapping never in payload nor upstream).

## Open questions (resolve during decomposition, not here)
- Concrete wire encoding/transport for delivery (HTTPS batch vs. queue) — deferred to implementation.
- Exact credential broker / short-lived-token issuer shape — coordinate with #459 identity work.
- Reference collector packaging/storage backend specifics — downstream of an accepted contract.
