## Context

The durable loop supervisor (`core/scripts/loop/supervisor.ts`) drives items through the
`pipeline/loop-execution@1` contract. The real seam is `realDispatchItem` in
`core/scripts/pipeline.ts`:

1. Spawn a child `pipeline <issue>` process with `stdio: "inherit"` (no `--detach`).
2. Wait for exit.
3. Map the issue's final labels to a terminal outcome.
4. Return evidence with a **fabricated** `pipeline_run_id`:
   `pipeline-loop-${request.run_id}-${request.item_id}`.

Meanwhile the child advance already creates a real run store at
`.agent-pipeline/runs/<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>/` with `events.jsonl` carrying
`stage_start`, `review_verdict`, etc. (`runIdFor` / `initRunDir` in `run-store.ts`).
Nothing joins the supervisor's loop events to that directory. The contract comment on
`LoopEvidencePointer.pipeline_run_id` already *says* it is
"Agent Pipeline's own run id (`.agent-pipeline/runs/<run-id>`)" — the implementation
violates that comment.

Detached launch already solved the same identity problem for `/pipeline N --detach`: the
parent pins a run id via `runIdFor`, passes `--run-id` to the child, and publishes a
machine-readable pointer (`run-store.json` / stdout) with absolute `events.jsonl` and
`terminal.log` paths (`run-directory-layout` capability). Loop dispatch does not reuse that
pattern today.

Consumers that need this join: harness UX following a loop run (#665/#666/#668 cluster),
audit after the fact, and any multiplex that wants `/pipeline N`-equivalent stage
timelines for the active item without scanning all run directories by mtime.

## Goals / Non-Goals

**Goals:**

- Publish a durable, machine-readable join between loop item dispatch and the real
  advance run store as soon as the run id is known (preferably at dispatch start).
- Publish terminal linkage (same ids + outcome) when the child finishes.
- Make `LoopEvidencePointer.pipeline_run_id` truthful when a run store exists.
- Keep unit tests pure via injected dispatch / run-store seams.
- Preserve synchronous whole-item hand-off and the never-merge boundary.

**Non-Goals:**

- Redesigning the supervisor to fully async multi-detach concurrent children.
- Bridging every child advance event into the loop `events.jsonl` (single stream) —
  optional later alternative noted in the issue; this change links *to* the child stream.
- Skill orchestration rewrite (#668) or skill-text-only documentation.
- Changing lock/ownership model, recovery budget, merge barrier, or stage machine.
- Guaranteeing mid-flight linkage if the child dies before any run store exists (only
  terminal failure linkage is required in that case).

## Decisions

### Decision 1 — Pin the advance run id in the parent before spawn (reuse `--run-id`)

**Choice:** Before spawning the child advance, the dispatch seam computes
`pipeline_run_id = runIdFor(issue, now)` and the absolute run directory /
`events.jsonl` path under the resolved repo root, then passes `--run-id <id>` on the
child argv (the same internal flag detached launch already uses). The supervisor (or
dispatch callback) can emit start linkage **before** the long wait, using those known
values.

**Why not poll for the child's self-created run directory?**

- Polling races with crash-before-init and with multiple historical runs for the same
  issue (mtime heuristic is exactly what we want to stop relying on).
- Pinning is already production-proven for detach and keeps one authoritative id.

**Why not discover only after exit?**

- That satisfies terminal audit but fails the harness UX goal: follow stage progress
  *during* the long in-flight window. Issue AC explicitly allows "start or as soon as
  known"; pin-before-spawn is the earliest durable moment without async redesign.

**Fallback:** If spawn fails before the child can init the store, terminal linkage still
records the intended `pipeline_run_id` (or omits a non-existent path) plus
`failed`/`abandoned` outcome — never advertise an absolute events path that does not
exist as if it were live proof.

### Decision 2 — Start and end are separate durable loop events

**Choice:** Append two supervisor-owned event kinds on the **loop** run's append-only
log (via the existing loop store `appendEvent` seam):

| Kind (illustrative) | When | Payload (minimum) |
|---------------------|------|-------------------|
| `loop_item_advance_linked` (start) | After pin / before or at child wait | `item_id`, `pipeline_run_id`, `events` (absolute path when known) |
| `loop_item_advance_finished` (end) | After child terminal response | same ids + `outcome` (+ events path when known) |

Exact kind strings are implementation detail as long as they are stable, documented in
the capability, and distinct from coarse `loop_item_started` / `loop_item_transitioned`.

**Why not only enrich the response evidence pointer?**

- Evidence is available only at the end of a synchronous dispatch. Harnesses following
  the loop stream need a start signal mid-wait.
- The supervisor already appends item lifecycle events; adding linkage kinds keeps one
  stream for "what is the loop doing" while pointing at the advance stream for stage
  detail.

**Why not only enrich `loop_item_started`?**

- `loop_item_started` is written when the ledger moves to `in_progress`, which today is
  **before** dispatch returns the evidence. The run id is known only inside the dispatch
  seam unless we pre-pin and thread the pin into the supervisor. Prefer an explicit
  linkage event (or a callback/hook from dispatch) so the join key is never conflated
  with ledger state transitions.

**Threading pin into the supervisor:** either

1. the dispatch implementation emits start linkage itself via an injected
   `onAdvanceLinked` / store seam, or
2. the supervisor pre-computes the pin, records start linkage, then passes the pin into
   the request / a small extension of the request shape.

Prefer (1) or a pure helper shared by both if request schema churn is undesirable:
keep `pipeline/loop-execution@1` request fields stable unless a versioned extension is
required. A local (non-contract) pre-pin + child argv is enough; the **response**
evidence carries the same real id back for terminal recording.

### Decision 3 — Truthful `LoopEvidencePointer`; optional absolute events path

**Choice:**

- `pipeline_run_id` MUST be the basename of the advance run directory
  (e.g. `623-2026-07-29T13-49-56-421Z`) when that store is pinned or exists.
- Add optional `events_path` (absolute filesystem path to `events.jsonl`) on the
  evidence pointer for consumer convenience. Optional so existing fakes keep validating;
  production dispatch sets it when known.
- Synthetic `pipeline-loop-…` MAY remain only when no run store can be established
  (documented fallback). It MUST NOT be returned as the sole join key when a real store
  was pinned or created.

**Schema:** additive field on `LoopEvidencePointer`; `pipeline/loop-execution@1` schema
id string stays `@1` if the contract remains backward-compatible for readers that ignore
unknown fields (mirrors other additive optional fields like `worktree_root`). If strict
validators elsewhere require an allowlist update, update those in the same change.

### Decision 4 — Child argv extension is internal, not a new per-stage verb

**Choice:** Extend `dispatchItemChildArgs` to accept an optional pinned `--run-id` (and
any flags already required for path identity). This is still a whole-item hand-off —
no per-stage API. The child continues to run the normal advance loop to completion
(no `--once`), same as today.

**Out of scope alternative:** bridge child events into loop `events.jsonl` tagged with
`item_id` (single stream). Rejected for this change: higher coupling, larger fan-in of
event schemas, and not required once the join key + path are durable.

### Decision 5 — Test seams

**Choice:**

- Pure helpers for: build child argv with pinned run id; build start/end linkage
  payloads; map evidence pointer from known run store paths.
- `realDispatchItem` (or a thin wrapper) accepts injectable deps: `spawn`, `now`,
  `runIdFor`/`runDirPath`, issue/PR readers, and optionally `onAdvanceLinked` for the
  start callback — so unit tests never spawn a real process or touch the real
  filesystem.
- Supervisor tests inject a fake `dispatchItem` that calls the linkage callback / returns
  real-shaped evidence, and assert loop events contain start + end linkage.

Regression that bites today: a test asserting response `evidence.pipeline_run_id` equals
the pinned/store id fails against the current synthetic string.

## Risks / Trade-offs

- **[Risk] Child ignores or mishandles `--run-id`** → Mitigation: reuse the existing
  internal pin path already used by detach; add a unit/integration-style test that the
  dispatch argv includes `--run-id` and that evidence echoes it.
- **[Risk] Absolute paths differ across hosts / worktrees** → Mitigation: paths are
  host-local observability, same as today's run store; documented as absolute on the
  host that ran the loop, not as portable cross-host URLs.
- **[Risk] Request schema churn if we put run id on the request** → Mitigation:
  Decision 2 prefers keeping the public request shape stable; pin is an implementation
  detail of the real dispatch seam unless a future engine needs it on the wire.
- **[Risk] Duplicate start events on resume/retry** → Mitigation: each dispatch attempt
  may emit its own start/end pair with its own pinned run id; consumers join by
  `(item_id, pipeline_run_id)` not by item alone. Do not overwrite prior pairs.
- **[Risk] Synthetic fallback still confuses consumers** → Mitigation: only when no
  store exists; tests cover "store exists ⇒ never synthetic-only"; document the
  fallback in the capability.
- **[Trade-off] Two streams (loop + advance) instead of one bridged stream** → Accept:
  smaller change, reuses Desk contract on the advance side, enables multiplex without
  rewriting event schemas.

## Migration Plan

- Additive observability only; no migration of historical loop runs required.
- Old loop events without linkage remain readable; consumers treat missing linkage as
  "pre-#667" and may fall back to mtime scan (degraded).
- Deploy by normal PR → `pipeline:ready-to-deploy` → human merge. No config flag
  required; behavior is always-on for real dispatch.

## Open Questions

- Exact event kind string names (`loop_item_advance_linked` /
  `loop_item_advance_finished` vs enriching existing kinds) — finalize at implement time
  against any harness early-adopter expectations from #665/#666 if those land first.
- Whether `events_path` lives only on loop events, only on evidence, or both (design
  prefers both when known: events for mid-flight follow, evidence for terminal audit).
