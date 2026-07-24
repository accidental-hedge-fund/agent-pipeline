## Why

Agent Pipeline runs across many repositories and hosts, but each repo keeps its own
`.agent-pipeline/runs/*` store and the only cross-boundary hook is the optional `event_sink`
(#343), which forwards one raw line to a local command with no shared identity, no durable
ingestion contract, no cross-repo aggregation, and no fleet-level query. A customer operating a
fleet therefore cannot measure reliability, cost, corrections, blockers, or health without manually
inspecting fragmented, repo-local artifacts. This change designs a first-class, **customer-controlled**
fleet telemetry plane — a versioned envelope, a durable delivery mode, a reference collector contract,
and read-only fleet reporting — **without** requiring Agent Pipeline maintainers to host customer
telemetry.

This is a forward-looking, **intent-only** change. It captures the observability contract, its trust
boundary, and its recovery semantics; it introduces no engine code in this step, keeps local run
artifacts as the default source of truth, and preserves the current no-sink behavior exactly.

## What Changes

- **A versioned fleet envelope around existing run events.** Wrap the already-sanitized, versioned run
  records (the `appendEvent` stream reused from #343) in a fleet envelope carrying bounded `tenant_id`,
  `installation_id`, a **pseudonymous** `repo_id`, `host_id`, Pipeline version, run ID, event
  `schema_version`, an explicit envelope version, and per-run monotonic sequence metadata — with
  repository names and local paths excluded by default.
- **A durable, authenticated delivery mode.** Add an opt-in top-level `fleet` config block (distinct
  from `event_sink`'s strict `command`/`mode` schema, which is left backward compatible) that delivers
  fleet envelopes to a customer-controlled collector with a local spool, bounded retry/backoff,
  acknowledgements, deterministic idempotency keys, replay, explicit spool-overflow behavior, and
  scoped ingest credentials. Delivery is **at-least-once** and **never** changes a Pipeline stage
  outcome; delivery lag, drops, rejected schemas, and last successful acknowledgement are visible
  through machine-readable diagnostics.
- **A reference collector contract.** Define a deployable/reference collector that validates schemas,
  rejects malformed or unsupported versions, supports forward-compatible optional fields under an
  explicit migration policy, enforces tenant isolation (one tenant/installation cannot write to or
  query another's data), deterministically deduplicates events so duplicate delivery does not skew
  metrics, and writes to **customer-owned** storage.
- **Read-only fleet reporting.** Aggregate the existing `scoreboard`/`improve` metrics across
  authorized repositories and hosts into human and JSON fleet reports that filter/group by pseudonymous
  repo, installation, host, Pipeline version, stage, harness/model, outcome, and time window; include
  run counts, active/stale installations, delivery health, top blocker/failure classes, and correction
  recurrence (when #499–#501 evidence is available) — while preserving evidence lineage back to source
  runs. Operators map pseudonymous repo IDs to friendly names **locally**; that mapping never reaches
  upstream maintainers through this feature.
- **Documented, testable data governance.** Retention, deletion, export, access audit, and credential
  rotation are specified as customer-controlled, documented, and testable behaviors.

This change reuses the #343 event sink and the existing sanitized, versioned records rather than
inventing a second evidence system; coordinates with #459 for identity/cross-host assumptions **without**
treating aggregation as a distributed lock; ingests future `correction_event` evidence from #499–#501
without changing its semantics; and stays disjoint from #502 (which reports probable *product* faults
upstream to maintainers — this issue aggregates a customer's *own* fleet telemetry into that customer's
control plane). It adds no auto-merge path and no cross-host mutation, locking, queue ownership, or
control-plane command channel — this is telemetry and read-only analysis only (golden rule #4).

## Acceptance Criteria

- [ ] Multiple Pipeline installations can deliver events to one customer-controlled endpoint using a
      documented, versioned protocol (proven by a multi-installation delivery test that drives events
      from ≥2 installations into one collector fake and asserts both land under one tenant).
- [ ] Every event carries stable `tenant`/`installation`/`repo`/`run` identity plus per-run ordering
      metadata, and by default exposes **no** repository name or local path (proven by an envelope-shape
      test and a redaction test asserting the raw repo name/path never appears).
- [ ] Delivery is at-least-once with bounded local spooling, retry/backoff, acknowledgements,
      deterministic idempotency, and explicit overflow behavior, and duplicate delivery does not skew
      metrics (proven by spool-persistence, idempotency-key, retry-backoff, overflow, and
      dedup-does-not-double-count tests that bite).
- [ ] A sink outage never changes a Pipeline stage outcome, while delivery lag, drops, rejected
      schemas, and last successful acknowledgement are visible through machine-readable diagnostics
      (proven by an outage test asserting identical stage outcome + a diagnostics-shape test).
- [ ] Authentication uses scoped ingest credentials, and one tenant/installation cannot write to or
      query another tenant's data (proven by cross-tenant write-refused and query-refused tests).
- [ ] The collector rejects malformed/unsupported schemas and accepts forward-compatible optional
      fields under an explicit migration policy (proven by malformed-rejected, unknown-optional-field-
      accepted, and unsupported-major-rejected tests).
- [ ] Fleet human and JSON reports filter/group by pseudonymous repo, installation, host, Pipeline
      version, stage, harness/model, outcome, and time window (proven by a filter/group test over a
      multi-repo/multi-host fixture).
- [ ] Fleet reports include the existing scoreboard metrics plus run counts, active/stale
      installations, delivery health, top blocker/failure classes, and correction recurrence when
      #499–#501 evidence is present (proven by a report-contents test; correction recurrence asserted
      only when correction evidence is in the fixture).
- [ ] Operators can map pseudonymous repo IDs to friendly names locally or in customer-controlled
      metadata, and upstream maintainers never receive that mapping through this feature (proven by a
      local-mapping test and asserted in the trust-boundary spec).
- [ ] Retention, deletion, export, access audit, and credential rotation are documented and testable,
      and deletion/export are refused across tenant scope (proven by per-behavior tests: retention
      window, tenant deletion, cross-tenant deletion refusal, export dump, cross-tenant export refusal,
      audit entry, and rotation without repository-config change).
- [ ] Existing `event_sink.command`, additive/exclusive modes, local `scoreboard`, and local `improve`
      remain backward compatible (proven by an existing-behavior test with no `fleet` block present).
- [ ] Tests cover multiple tenants/repositories/hosts, out-of-order and duplicate events, sink
      outage/recovery, spool overflow, credential revocation, schema skew, redaction, and unauthorized
      queries — each biting (failing without the guard).
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror and `npm run ci` (including
      `openspec validate --all`) is green.

## Capabilities

### New Capabilities

- `fleet-telemetry-envelope`: the versioned fleet envelope wrapping the existing sanitized run events —
  bounded tenant/installation/pseudonymous-repo/host identity, Pipeline/run/schema/envelope versions,
  per-run sequence ordering, and the data-minimization guarantee (no repo names, local paths, raw
  prompts/output, source, secrets, arbitrary env, or human identity).
- `fleet-telemetry-delivery`: the opt-in, authenticated, durable delivery mode — local spool,
  at-least-once with idempotency keys and acknowledgements, bounded retry/backoff, replay, explicit
  overflow behavior, scoped ingest credentials with rotation/revocation, non-fatal-to-the-run
  semantics, and machine-readable delivery-health diagnostics.
- `fleet-collector-contract`: the reference/deployable collector contract — schema validation,
  malformed/unsupported rejection, forward-compatible optional fields with an explicit migration
  policy, tenant isolation, deterministic deduplication, and writes to customer-owned storage with no
  upstream path.
- `fleet-reporting`: the read-only fleet reports — cross-repo/host aggregation of the existing
  scoreboard/improve metrics, filter/group dimensions, the required report contents, evidence lineage,
  and customer-local pseudonymous-repo → friendly-name mapping.
- `fleet-data-governance`: the documented, testable data lifecycle — retention, deletion, export,
  access audit, and credential rotation, all customer-controlled.

### Modified Capabilities

<!-- None. Fleet telemetry is a separate, opt-in `fleet` config block that reuses the existing
     sanitized `appendEvent` records and the #343 event-sink producer path without changing its
     requirements. `configurable-event-sink` (strict `command`/`mode` schema, additive/exclusive
     modes) and the local `factory-scoreboard` / `improve-command` capabilities are reused unchanged
     and remain backward compatible. -->

## Impact

- **Specs:** five new capabilities (above). No existing requirement is modified.
- **Code (implementation step only, not this change):** a fleet-envelope builder over the existing
  `appendEvent` records, a durable spool + delivery worker layered on the #343 sink producer path, a
  reference collector contract with tenant isolation + dedup, a read-only `pipeline fleet` reporting
  reader over aggregated scoreboard/improve metrics, and governance operations — all behind dependency
  seams (`deps`/`Deps` fakes) with no real network/git/subprocess in tests, sitting near
  `core/scripts/` alongside the run-store, `gh.ts`, and the scoreboard/improve readers.
- **Interoperability:** additive and default-off. With no `fleet` block the pipeline behaves exactly as
  today — `event_sink`, local `scoreboard`, and local `improve` are unchanged. Reuses #343 records,
  coordinates identity with #459 (no distributed lock), ingests #499–#501 correction evidence
  unchanged, and stays disjoint from #502. No auto-merge, no cross-host mutation/locking/command
  channel, no upstream telemetry to maintainers.

## Deferred implementation (tracked follow-ups)

This change is design/specs only — no engine code changes. The implementation is decomposed into
tracked follow-up issues to be started only after this change merges: (1) the fleet envelope +
data-minimization builder; (2) the durable delivery mode (spool, retry, acks, idempotency, health);
(3) the reference collector contract (validation, isolation, dedup, migration policy); (4) read-only
fleet reporting; (5) the documented, testable data-governance operations.
