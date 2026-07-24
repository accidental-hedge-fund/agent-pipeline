# Tasks — fleet-telemetry-aggregation (#503)

> Intent-only change. This checklist is the accepted **implementation order** for the downstream
> decomposition; no application code lands in this OpenSpec step. Each numbered section is separately
> reviewable, and the local/no-sink path stays the default throughout.

## 1. Fleet envelope + data minimization

- [ ] 1.1 Define the fleet envelope wrapping the existing sanitized `appendEvent` record: bounded
      `tenant_id`, `installation_id`, pseudonymous `repo_id`, pseudonymous `host_id`, `pipeline_version`,
      `run_id`, event `schema_version`, explicit `envelope_version`, and per-run monotonic `seq`.
- [ ] 1.2 Derive `repo_id`/`host_id` deterministically and pseudonymously per installation; exclude
      repository names and local paths from the payload by default.
- [ ] 1.3 Guarantee the wrapped payload is byte-identical to the #343-screened `events.jsonl` line
      (injection denylist + secret redaction inherited, no re-derivation, no new payload fields).
- [ ] 1.4 Single-source the envelope schema (mirroring the review-verdict schema pattern) and add a
      drift-guard test; add a redaction test asserting repo name/path/prompt/output/secret/human
      identity never appear in a payload.

## 2. Durable authenticated delivery mode

- [ ] 2.1 Add the opt-in top-level `fleet` config block (identity, collector endpoint, scoped credential
      reference, spool/retry/overflow settings) with strict schema validation; keep `event_sink`
      unchanged and prove no-`fleet`-block behavior is identical to today.
- [ ] 2.2 Implement the durable local spool: persist envelopes before delivery, retire only on
      acknowledgement, and survive process restart (replay from spool).
- [ ] 2.3 Implement at-least-once delivery with a deterministic idempotency key
      (`(tenant, installation, run_id, seq)` or content digest), bounded retry/backoff, and
      acknowledgements.
- [ ] 2.4 Define explicit, bounded spool-overflow behavior (documented drop-oldest or back-pressure,
      never unbounded) that emits a diagnostic when it engages.
- [ ] 2.5 Make delivery non-fatal to any run (a sink outage never changes a stage outcome) and expose
      machine-readable delivery-health diagnostics: lag, drop count, rejected-schema count, last
      successful acknowledgement.
- [ ] 2.6 Authenticate with a scoped ingest credential referenced (not inlined) by config; support
      rotation and revocation without repository-config changes.

## 3. Reference collector contract

- [ ] 3.1 Implement the versioned wire transport profile (design.md D10): authenticated HTTPS ingest
      endpoint, canonical field types/limits, idempotency-key encoding, `202`/`4xx` acknowledgement and
      reason-code rejection schema, and a `/fleet/v1/capabilities` endpoint.
- [ ] 3.2 Validate each envelope; reject malformed and unsupported-major-version envelopes with a
      machine-readable reason; accept forward-compatible optional fields; document the migration policy.
- [ ] 3.3 Enforce tenant isolation: a scoped write credential writes only its tenant's data and a query
      credential reads only its tenant's data — cross-tenant write and query are refused.
- [ ] 3.4 Deterministically deduplicate on the idempotency key so duplicate delivery does not skew
      metrics; reconstruct per-run order from `(run_id, seq)`.
- [ ] 3.5 Write to customer-owned storage; assert there is no upstream path to Agent Pipeline
      maintainers.
- [ ] 3.6 Tests: capabilities/ack/rejection wire-format conformance, multi-tenant/multi-repo/multi-host
      ingest, out-of-order and duplicate events, malformed + unsupported-version rejection,
      unknown-optional-field acceptance, cross-tenant write/query refusal — each biting.

## 4. Read-only fleet reporting

- [ ] 4.1 Add a read-only `pipeline fleet` report (human + JSON) that aggregates the existing
      scoreboard/improve metrics across authorized repos/hosts; assert no GitHub/worktree/config/run-
      artifact mutation.
- [ ] 4.2 Support filter/group by pseudonymous repo, installation, host, Pipeline version, stage,
      harness/model, outcome, and time window.
- [ ] 4.3 Include the required report contents: existing scoreboard metrics plus run counts,
      active/stale installations, delivery health, top blocker/failure classes, and correction
      recurrence when #499–#501 evidence is present.
- [ ] 4.4 Preserve evidence lineage: every aggregated metric traces back to the contributing
      runs/events.
- [ ] 4.5 Resolve pseudonymous `repo_id` → friendly name customer-locally (local mapping or
      customer-controlled collector metadata); never place the mapping in the payload or an upstream path.

## 5. Data governance (documented + testable)

- [ ] 5.1 Retention: enforce a customer-configured retention window; test that out-of-window data is
      dropped/expired.
- [ ] 5.2 Deletion: support tenant/installation data deletion gated on a privileged credential bound to
      the target tenant; test that deleted data no longer appears in queries and that a cross-tenant
      deletion attempt is refused and audited.
- [ ] 5.3 Export: support a customer-owned export dump limited to the caller's scoped tenant; test its
      shape and that a cross-tenant export attempt is refused and audited.
- [ ] 5.4 Access audit: record an audit entry (scoped principal + outcome) for ingest/query/deletion/
      export/credential operations; test it is written for both accepted and refused attempts.
- [ ] 5.5 Credential rotation: rotate/revoke a scoped credential without repository-config change; test
      a revoked credential's write/query is refused.

## 6. Gate

- [x] 6.1 `node scripts/build.mjs` regenerates the `plugin/` mirror; commit it in the same change.
- [x] 6.2 `npm run ci` (incl. `openspec validate --all`) is green; every new test bites (fails without
      the guard).

Sections 1–5 above describe the accepted implementation order for the tracked follow-up issues
(see "Deferred implementation" in `proposal.md`); this OpenSpec change is intent-only and lands no
application code, so those items stay unchecked here and are the scope of their own follow-up
changes.
