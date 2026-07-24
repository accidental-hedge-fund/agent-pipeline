# Tasks — orchestration-execution-boundary (#505)

> Intent-only change. This checklist is the accepted **implementation order** for the downstream
> decomposition; no application code lands in this OpenSpec step. Each numbered section is separately
> reviewable, and steps 1–4 ship **no** remote dependency.

## 1. Protocol envelopes and identity (control↔execution seam)

- [ ] 1.1 Define the `WorkAssignment`, `ProgressEvent`, `ArtifactManifest`, and `WorkResult` envelope
      types with explicit `protocolVersion`/`schemaVersion` and stable
      `tenant`/`installation`/`run`/`stage`/`attempt`/`assignmentId` identity.
- [ ] 1.2 Specify required capabilities, repository/environment authorization scope, and input/evidence
      digests on `WorkAssignment`.
- [ ] 1.3 Single-source the envelope schemas (mirroring the review-verdict schema pattern) and add a
      drift-guard test so prompts/consumers cannot diverge from the schema.
- [ ] 1.4 Define capability negotiation + backward/forward compatibility rules (negotiate-down on newer
      minor, deterministic reject on incompatible major).

## 2. Default local adapter (reference implementation, first)

- [ ] 2.1 Route the existing in-process harness/worktree path through a local adapter that consumes a
      `WorkAssignment` and returns `WorkResult` + `ArtifactManifest`.
- [ ] 2.2 Prove behavior-parity: with no execution config, observable behavior is identical to today
      (no service, no network) — regression test that bites if a mandatory dependency is introduced.
- [ ] 2.3 Add a workflow-invariance test harness that drives the same workflow through adapter fakes and
      asserts identical control-plane lifecycle/policy decisions across modes.

## 3. Control-plane delivery safety (idempotency, leases, fencing)

- [ ] 3.1 Implement `(assignmentId, attempt)` idempotency, lease issuance with deadlines, and
      monotonically increasing fencing tokens.
- [ ] 3.2 Enforce "advance only from current lease holder with current fencing token"; retain
      duplicate/stale/superseded results as evidence without re-advancing.
- [ ] 3.3 Tests: duplicate assignment, stale fencing token, concurrent claim, retry after partial
      execution, late result after lease expiry, cancellation race — each biting.
- [ ] 3.4 Map every boundary failure mode to one deterministic outcome + machine-readable diagnostic
      (disconnect/reconnect, lease expiry, worker loss, protocol skew, partial artifact upload).

## 4. Execution-worker runtime contract

- [ ] 4.1 Define the worker duties: bounded-scope execution; independent local
      filesystem/process/network/secret/repository/command boundary enforcement.
- [ ] 4.2 Emit heartbeats, bounded structured progress/logs, `ArtifactManifest`, and a terminal
      `WorkResult` bound to assignment identity and attempted SHA.
- [ ] 4.3 Prove the worker holds no lifecycle/release-policy logic: a worker-supplied lifecycle claim is
      ignored for advancement (test).
- [ ] 4.4 Tests: out-of-scope operation refused, malicious result/artifact metadata rejected, partial
      artifact upload detected.

## 5. Management plane (fleet)

- [ ] 5.1 Worker registration + mutual, installation-scoped authentication; rotation/revocation without
      repository-config changes.
- [ ] 5.2 Capability + authorization gating **before** assignment; capability-mismatch and
      unauthorized-repo selection tests.
- [ ] 5.3 Pools, drain, health, quotas, version/policy attachment; drain stops new assignments while
      in-flight ones complete or re-assign.
- [ ] 5.4 Feed sanitized read-only health/delivery telemetry to #503 without exposing a command channel.

## 6. Trust boundary and evidence lineage

- [ ] 6.1 Enforce outbound-only worker connectivity (no inbound customer-network listener required by
      any control-plane operation).
- [ ] 6.2 Default-exclude raw source, reusable secrets, unrestricted env, and sensitive logs from
      control-plane transport; explicit policy gate for any transfer — redaction/transport-default test.
- [ ] 6.3 Bind every accepted result into one auditable lineage chain
      (assignment → input digest → worker identity/capabilities → attempted SHA → result → artifact
      digests), reusing the #153–#161 evidence contracts — reconstruction test.

## 7. Documentation and coordination

- [ ] 7.1 Document trust boundaries, threat model, deployment topologies (local / private VM /
      Kubernetes), operational responsibilities, and the migration path from the coupled runtime.
- [ ] 7.2 Coordinate identity/leases/cross-host ownership with #459; replace host-local assumptions
      only at the assignment/lease layer, not every lock site.
- [ ] 7.3 Clarify the relationship to `external-stage-executors` (where execution runs vs. which model
      answers a stage) so the two are not conflated.

## 8. Gate

- [ ] 8.1 `node scripts/build.mjs` regenerates the `plugin/` mirror; commit it in the same change.
- [ ] 8.2 `npm run ci` (incl. `openspec validate --all`) is green; every new test bites (fails without
      the guard).
