# Design — orchestration-execution-boundary (#505)

## Context

Agent Pipeline currently runs orchestration and execution in one process on one host. The engine
selects a stage, creates/uses a worktree, invokes a local harness CLI, captures evidence from the
run directory, evaluates gates, and advances labels — all in-band. This change designs the **logical
seam** that lets the *execution* half run in customer-operated infrastructure while the
*orchestration* half stays authoritative for lifecycle and policy. It is a decision-complete
architecture proposal: it fixes the protocol, trust boundary, delivery semantics, and the
local-adapter-first migration order. It deliberately does **not** decompose into transport, service,
or fleet-UI work — those are downstream and out of scope (#505 "should remain a standalone,
decision-complete capability issue rather than an umbrella tracker").

## Goals / Non-goals

**Goals**
- One workflow definition, three execution modes (local / private VM / Kubernetes) with identical
  control-plane decisions.
- A versioned, structured protocol that survives duplicate delivery, worker loss, and version skew.
- A trust boundary that keeps source, secrets, and sensitive logs customer-local by default.
- The current local path re-expressed as the reference adapter *before* any remote transport.

**Non-goals** (per issue "Out of scope")
- A mandatory hosted service, proprietary runner backend, fleet UI, billing, or telemetry store.
- Full fleet telemetry/reporting (#503) and upstream product-fault reporting (#502).
- Auto-merge / deploy / rollback, or anything past the human-owned `ready-to-deploy` boundary.
- Solving every cross-host lock site (#459) — replace host-local assumptions only where the protocol
  requires distributed ownership.
- Moving model inference into/out of customer infrastructure.

## Key decisions

### D1 — Three planes, not two
We separate **control** (lifecycle, queueing, policy, budgets, gates, cancellation, retry, handoff,
worker selection), **execution** (repo work, harness, commands, artifacts, local boundary
enforcement), and **management** (register/auth/inventory/drain/revoke/rotate/pools/health). The
management plane is distinct from control because fleet identity and lifecycle (rotation, revocation,
drain) evolve independently of any single run, and distinct from #503 because #503 is read-only
observability, not a command channel.

### D2 — Five envelopes, structured end-to-end
`WorkAssignment` and `CancellationDirective` (control→worker), `ProgressEvent` and `ArtifactManifest`
(worker→control, streaming), `WorkResult` (worker→control, terminal). No terminal-prose scraping: the
control plane consumes typed fields and digests only. Each envelope carries explicit `protocolVersion`
and `schemaVersion`. This mirrors the repo's existing preference for typed contracts over prose parsing
(cf. the review verdict JSON schema single-source).

`CancellationDirective` is the control plane's only way to tell a worker that an in-flight assignment
is cancelled after dispatch. It is bound to the same `assignmentId`/attempt identity and fencing token
as the `WorkAssignment` it cancels, so a worker can never honor a directive for an assignment it no
longer holds the lease for. A worker SHALL acknowledge receipt (or return the directive in its next
`ProgressEvent`/`WorkResult` if it has no separate control channel to acknowledge over), and the
control plane retries delivery until acknowledged or the lease expires. If a `WorkResult` and a
`CancellationDirective` race, D4's fencing rule already decides the outcome: a result is only
state-advancing while it bears the current fencing token, and the control plane marks the fencing token
superseded as part of issuing the cancellation, so a racing terminal result cannot advance state.

### D3 — Identity is the spine of every envelope
Every envelope carries stable `tenant / installation / run / stage / attempt` identity plus the
`assignmentId`. Idempotency key = `(assignmentId, attempt)`. Fencing token = a monotonically
increasing value issued with the lease; the control plane refuses any result/claim whose fencing
token is not the current one for that assignment. This is what makes at-least-once delivery safe: a
late or duplicated worker cannot advance state because its fencing token is stale.

### D4 — Leases + at-least-once, never exactly-once
Delivery and execution are treated as **at-least-once**. A lease binds an assignment to one worker
for a deadline; on expiry the control plane may re-assign under a **new attempt** (new fencing token).
The prior worker's late result is accepted only for evidence, never for advancement. This avoids the
distributed-systems fantasy of exactly-once and matches the conservative "unknown ⇒ don't advance"
posture used elsewhere in the engine.

### D4a — Durable atomic assignment-state authority
Fencing tokens only prevent double-advancement when their comparison and the resulting state
transition share a single durable atomic commit boundary. The control plane therefore requires one
durable assignment-state authority — not per-process memory — that atomically compares and commits
assignment ownership, attempt, lease-holder, fencing token, cancellation state, and accepted
idempotency keys together with the lifecycle transition they gate. A restarted control-plane process
or a failed-over controller instance rehydrates exclusively from this authority before accepting or
advancing any result; it never reconstructs "current" from in-memory state. This closes the gap a bare
fencing-token comparison leaves open across restart/failover, where two processes could otherwise each
believe their comparison is authoritative.

### D5 — Outbound-only, data-minimized trust boundary
Workers initiate authenticated outbound connections; no inbound listener into customer networks is
required. By default the control plane transports **references and digests**, not raw source, reusable
secrets, unrestricted env, or sensitive logs. Any actual transfer of those requires an explicit policy
gate. Credentials are short-lived and worker-local-resolved where possible; mutual, installation-scoped
auth means rotation/revocation never touches repository config.

### D6 — Local adapter first (reference implementation)
The current in-process path becomes the default adapter to the same contract. Concretely: the engine
builds a `WorkAssignment`, hands it to the **local adapter**, which runs the existing harness/worktree
path in-process and returns a `WorkResult` + `ArtifactManifest`. With no execution config present this
is indistinguishable from today's behavior (no service, no network). Only after this is proven do
remote transports become implementable — and they must satisfy the exact same contract. This ordering
is a hard requirement, not a suggestion: it guarantees the seam is real and load-bearing before any
distributed complexity is added.

### D7 — Evidence lineage as one auditable chain
Reuse the #153–#161 run-artifact/event contracts. Every accepted result binds
`assignment → inputs(digest) → resolved worker + capabilities → attempted SHA → result → artifact
digests` into a single chain reconstructable from durable artifacts alone. No second evidence system.

### D8 — Deterministic failure taxonomy
Each boundary failure mode — disconnect/reconnect, lease expiry, worker loss, cancellation race, late
result, protocol skew, partial artifact upload — maps to one machine-readable diagnostic code and one
deterministic outcome (park / retry-new-attempt / reject). "Deterministic and observable" is a spec
requirement, tested per mode.

## Risks / trade-offs

- **Over-abstraction risk.** Designing a protocol before a remote consumer exists can gold-plate. Mitigated
  by D6 (local adapter is the only initial consumer and must pass the full contract) and by keeping this
  an intent-only change with no premature transport code.
- **Cross-host lock overlap with #459.** The engine's `/tmp` PID locks are host-local by design. This
  change replaces host-local ownership assumptions *only at the assignment/lease layer*, where distributed
  ownership is intrinsic; it does not re-open every lock site. Coordinated explicitly with #459.
- **Relationship to `external-stage-executors`.** That capability delegates *which model answers a stage*;
  this boundary governs *where the stage's execution runs*. They compose (a remote worker may itself use a
  configured executor) and neither subsumes the other. Called out in the proposal to prevent conflation.

## Migration path

1. Introduce the protocol envelopes and the local adapter; route the existing path through it (no
   behavior change, default-off for anything remote).
2. Add worker registration/auth/selection (management plane) with capability + authorization gating.
3. Add lease/fencing/idempotency enforcement in the control plane's result ingest.
4. Only then implement a remote transport as a second adapter satisfying the same contract.
Each step is separately reviewable; steps 1–3 ship no remote dependency.

## Open questions (resolve during decomposition, not here)

- Concrete wire encoding/transport for remote adapters (gRPC vs. HTTP long-poll vs. queue) — deferred.
- Exact credential broker shape and short-lived-token issuer — coordinate with #459 identity work.
- Kubernetes worker packaging specifics — downstream of an accepted protocol.
