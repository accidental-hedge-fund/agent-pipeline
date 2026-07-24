## Why

Today Agent Pipeline couples orchestration, repository access, harness execution, gates, evidence
capture, and host-local coordination inside one process on one machine. That is the right default
for local-first use, but it means private-network execution, heterogeneous worker fleets, and
centralized supervision cannot be added later without unwinding assumptions baked throughout the
engine. Issue #505 asks us to design the **logical boundary between orchestration (control plane)
and execution (execution plane)** now — before local assumptions calcify — so the same
decision-complete pipeline workflow can dispatch bounded work to a customer-operated runner (a local
machine, a private-network VM, a lab host, or a Kubernetes worker pool) while policy, lifecycle
state, and fleet supervision stay logically centralized.

This is a forward-looking, intent-only architecture change. It defines a portable execution contract,
its trust boundary, and its recovery semantics, and it requires the **existing in-process/local path
to be the first adapter to that contract** — it does **not** introduce a hosted service, a fleet UI,
remote transports, or any change to the current local-first default or the human-owned
`pipeline:ready-to-deploy` boundary (golden rule #4).

## What Changes

- **A versioned control↔execution protocol seam.** Define four envelopes — `WorkAssignment`,
  `ProgressEvent`, `ArtifactManifest`, and `WorkResult` — carrying stable
  tenant/installation/run/stage/attempt identity, required capabilities, authorization scope, lease /
  deadline / cancellation / idempotency / fencing metadata, input & evidence digests, and explicit
  protocol/schema versions. Consumption of results is structured — no terminal-prose scraping.
- **At-least-once delivery made safe.** Assignments carry idempotency keys, attempt identity, leases,
  and fencing tokens so duplicate delivery, worker failover, stale workers, and late results cannot
  double-advance or corrupt a run. Disconnect, lease expiry, worker loss, cancellation races, late
  results, protocol skew, and partial artifact upload have deterministic, observable outcomes.
- **A separated execution plane (worker runtime).** A worker performs checkout/worktree operations,
  harness invocations, edits, commands, tests, builds, and artifact production **only within the
  assigned scope**, enforces its own filesystem/process/network/secret/repository/command boundaries
  independently of control-plane intent, emits heartbeats/progress/bounded logs/evidence
  manifests/terminal result bound to assignment identity and attempted SHA, and contains **no**
  pipeline-lifecycle or release-policy decision logic.
- **A management plane for the fleet.** Register, authenticate (mutual, installation-scoped),
  inventory, drain, revoke, and rotate workers; manage pools, capabilities, versions, policy
  attachments, health, and quotas — with worker selection enforcing declared capabilities and
  repository/environment authorization **before** an assignment is issued. Credentials rotate/revoke
  without changing repository configuration.
- **A trust boundary and data-minimization default.** Worker connectivity is outbound-initiated (no
  inbound customer-network listener required); raw source, reusable secrets, unrestricted environment
  values, and sensitive logs are excluded from control-plane transport by default, with explicit
  policy gates for any transfer. Evidence lineage binds every accepted result to its assignment,
  worker identity/capabilities, input digest, attempted SHA, and artifact digests.
- **The local adapter is the reference implementation.** The current in-process/local execution path
  is re-expressed as the **default adapter** to this same contract before any remote transport exists.
  Local mode stays the default, needs no service, preserves existing CLI behavior/configuration, and
  keeps no mandatory network dependency.

This change is intent-only. It reuses the launcher/status/run-artifact/event contracts from
#153–#161 rather than inventing a second evidence system, coordinates identity/leases/cross-host
ownership with #459, and feeds sanitized telemetry to #503 without turning #503's read-only collector
into a command channel. It adds no auto-merge / auto-release / auto-deploy and does not move model
inference into or out of customer infrastructure.

## Acceptance Criteria

- [ ] The same decision-complete pipeline workflow runs unchanged against at least three declared
      execution modes — current local/in-process, a remote private-network VM, and a
      Kubernetes-backed worker — with the orchestration workflow definition identical across all three
      (proven by a workflow-invariance test that drives the same run through three adapter fakes and
      asserts identical control-plane decisions).
- [ ] Orchestration and release-policy decisions live exclusively in the control plane: a worker
      cannot advance run/stage lifecycle state, and a `WorkResult` that attempts a lifecycle
      transition is rejected (proven by a test that a worker-supplied lifecycle claim is ignored).
- [ ] A documented, versioned protocol covers assignment, progress, cancellation, artifacts, and
      terminal results, with explicit backward/forward-compatibility rules and capability negotiation
      (proven by a protocol-version-skew test: a newer-minor worker and an unknown-major worker each
      resolve deterministically — negotiate-down vs. reject).
- [ ] Worker selection rejects any worker lacking a declared required capability or the
      repository/environment authorization scope **before** an assignment is issued (proven by
      capability-mismatch and unauthorized-repo tests that assert no assignment is dispatched).
- [ ] Authentication is mutual and installation-scoped; a worker credential can be rotated and revoked
      without editing repository configuration, and a revoked credential's assignment claim is refused
      (proven by a worker-revocation test).
- [ ] Duplicate assignment delivery, concurrent claims for one assignment, worker failover, and late
      results cannot double-advance or corrupt a run: a stale fencing token / superseded attempt is
      refused, and only the current lease holder's result is accepted (proven by duplicate-assignment,
      concurrent-claim, and stale-fencing-token tests that bite).
- [ ] Outbound-only worker connectivity is supported end-to-end; no inbound customer-network listener
      is required by any control-plane operation (asserted in the protocol spec and the local-adapter
      contract).
- [ ] Raw source, reusable secrets, unrestricted environment values, and sensitive logs are excluded
      from control-plane transport by default; any transfer requires an explicit policy gate (proven
      by a redaction/transport-default test over a `WorkResult`/`ArtifactManifest` fixture).
- [ ] Worker loss, network partition, cancellation races, lease expiry, protocol skew, and partial
      artifact transfer each yield a deterministic recovery/parking outcome and machine-readable
      diagnostics (proven by per-failure-mode tests asserting the parked/retried state and a
      structured diagnostic code).
- [ ] Every accepted result carries an evidence-lineage chain binding assignment → inputs → resolved
      worker/capabilities → attempted SHA → result → artifact digests, reconstructable from durable
      artifacts alone (proven by an evidence-lineage reconstruction test).
- [ ] Local mode remains the default: no service required, existing CLI behavior/configuration
      unchanged, and no mandatory network dependency (proven by an existing-behavior test with no
      execution config present).
- [ ] Tests cover duplicate assignment, stale fencing token, concurrent claim, retry after partial
      execution, worker revocation, unauthorized repo access, capability mismatch, protocol-version
      skew, disconnect/reconnect, cancellation, and malicious result/artifact metadata — each biting
      (failing without the guard).
- [ ] Documentation captures the trust boundaries, threat model, deployment topologies, operational
      responsibilities, and a migration path from the current coupled runtime.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror and `npm run ci` (including
      `openspec validate --all`) is green.

## Capabilities

### New Capabilities

- `orchestration-execution-protocol`: the versioned control↔execution seam — the `WorkAssignment` /
  `ProgressEvent` / `ArtifactManifest` / `WorkResult` envelopes, their identity and versioning rules,
  at-least-once delivery with idempotency + leases + fencing, capability negotiation,
  compatibility/skew handling, the outbound-only trust boundary, data-minimization defaults, and the
  evidence-lineage chain. It is a protocol contract only; it grants no merge authority and relaxes no
  review gate.
- `execution-worker-runtime`: the execution-plane worker duties — bounded assignment execution, local
  filesystem/process/network/secret/repository/command boundary enforcement independent of
  control-plane intent, heartbeat/progress/bounded-log/evidence emission bound to assignment identity
  and attempted SHA, and the prohibition on any duplicated pipeline-lifecycle or release-policy logic.
- `execution-worker-management`: the management plane — worker registration, mutual
  installation-scoped authentication, inventory, drain, revoke, credential rotation, pools,
  capability/version declaration, policy attachment, health, and quotas, with capability +
  authorization enforcement gating selection before assignment.
- `local-execution-adapter`: the default in-process/local adapter to the protocol — the reference
  implementation that preserves local-first defaults (no service, no mandatory network, unchanged CLI
  behavior/config) and proves the seam without a remote transport.

### Modified Capabilities

<!-- None. This change introduces a new protocol boundary and its adapters; it does not alter the
     requirements of existing capabilities. `external-stage-executors`,
     `api-executor-request-controls`, and `api-executor-response-provenance` remain the per-stage
     model-delegation surface and are complementary — this boundary is about *where execution runs*,
     not *which model answers a stage*. -->

## Impact

- **Specs:** four new capabilities (above). No existing requirement is modified.
- **Code (implementation step only, not this change):** a control-plane assignment/lease/result
  ingest surface, a worker-runtime contract, a management-plane worker registry, and a default local
  adapter that re-expresses the current in-process harness path against the protocol — all behind
  dependency seams (`deps`/`Deps` fakes) with no real network/git/subprocess in tests. Likely to sit
  near `core/scripts/` alongside `harness.ts`, `worktree.ts`, and the run-artifact/event helpers.
- **Interoperability:** additive and default-off for anything remote. With no execution config the
  pipeline runs through the local adapter exactly as today. Coordinates with #459 (identity/leases),
  reuses #153–#161 evidence contracts, and feeds sanitized telemetry to #503. No auto-merge /
  auto-release / auto-deploy; model hosting is unchanged.

## Deferred implementation (tracked follow-ups)

This change is design/specs only — no engine code changes. Per #505's scope
("implementation should be decomposed only after the protocol, trust boundary,
and local-adapter migration design are accepted"), the implementation is
decomposed into these tracked follow-up issues, to be started only after this
change merges:

- **#589** — Implement the local execution adapter (reference in-process worker) to the protocol.
- **#590** — Add the remote-VM execution worker transport (depends on #589).
- **#591** — Add the Kubernetes worker-pool execution backend (depends on #590).
