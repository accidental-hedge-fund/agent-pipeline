## Context

Today factory observability is fragmented:

| Source | What it gives | Gap for remote/supervisor use |
| --- | --- | --- |
| `pipeline <N> --status --json` (#154) | Per-issue envelope | Single issue only; not factory-wide |
| Durable loop store status projection | Run id, items, lock holder, budgets | Includes lock-sensitive material; not remote-safe |
| Supervisor process-identity record | pid, host, heartbeat (refreshed **per cycle**) | Heartbeat stalls during long blocking dispatch; looks dead while alive |
| Supervisor audit | Action evidence trail | Unbounded internal evidence; not a public status contract |
| Factory scoreboard (#301) | Historical aggregate metrics | Windowed history, not live health |
| Engine pin / FRG / provider state | Track, pin, cooldown-ish signals | Separate commands/files; not one snapshot |
| #890 macro-controller (depends-on, not yet landed) | Contract revision, coarse phase, service identity | Status must read it when present without requiring it for legacy |

Issue #891 needs one **authoritative, allowlisted, pure read model** plus **independent health
dimensions** so external supervisors do not misread long work or expected waits as wedges, and do
not receive secrets or instruction-like free text.

Constraints that bind this design:

- Single-host lock/process evidence only; never claim cross-host death (#459 / #634).
- No autonomous merge; status is observation only.
- Edit `core/`, regenerate `plugin/`; `npm run ci` is the gate.
- Tests inject deps; no real network/git/subprocess.
- #654 campaign progress must not become the generic factory health owner.

## Goals / Non-Goals

**Goals:**

1. `pipeline factory status` (+ `--json`) as a pure versioned snapshot.
2. Explicit allowlist assembly so remote consumers never see forbidden material.
3. Controller-owned heartbeat on a bounded independent cadence during dispatch/wait/backoff.
4. Independent health dimensions: process liveness, durable progress, expected waiting.
5. Strict stuck/dead/unknown/healthy-waiting rules with honest unknowns for cost/telemetry.
6. Legacy and partial-source readability with attribution.
7. Canary-secret and prompt-text regression tests on every source object.

**Non-Goals:**

- Dashboard, notifications, mutating control plane.
- Exposing raw loop-store status over HTTP/MCP.
- Replacing scoreboard, per-issue status, audit, logs, or run artifacts.
- Implementing #890 itself (consume its evidence when available).
- Cross-host process-death claims.
- Remaining-quota or zero-cost invention when data is missing.

## Decisions

### Decision 1 — Pure assembler over injected readers (not a second ledger)

**Chosen:** Implement status as a pure function
`assembleFactoryStatus(sources, clock, probes) → FactoryStatusEnvelope` that reads only through
injected seams (controller/service record, loop status projection, process record, pin,
provider/cooldown, write-health, cost summaries). The CLI command maps filesystem/config into
those seams and prints human or JSON.

**Rejected:** A new durable "status ledger" that status writes.  
**Rejected:** Reusing the raw loop status object as the remote contract (contains tokens).

**Why.** Issue requires zero mutation and an allowlisted remote model distinct from internal
projections.

### Decision 2 — Versioned envelope with structured degraded/error states

**Chosen:** Envelope shape (normative intent; exact field names are implementation detail under
test):

- `schema_version` (string, start `"1"`)
- `status`: `ok` | `degraded` | `error` (top-level discriminant)
- `generated_at` (ISO-8601 from injected clock)
- `factory` / controller / service identity block (unknown when absent)
- `health` dimensions block (liveness, progress, waiting)
- `run` / contract / items / costs / sources attribution
- `error` when `status === "error"` (sanitized string; no canaries)

Partial source failure → `degraded` with per-source attribution, not silent omission that looks
healthy. Total inability to assemble → `error` still as valid JSON.

**Rejected:** Throwing unstructured stderr-only errors for machine consumers.  
**Rejected:** Schema version bump for every additive optional field (additives allowed within v1
when optional/unknown-safe).

### Decision 3 — Explicit output allowlist + denylist of source classes

**Chosen:** Two-layer protection:

1. **Allowlist:** only named fields may appear in the public envelope (and human rendering of it).
2. **Source sanitization:** free-text fields (issue titles, hold reasons, comments, next-action
   prose) are either dropped, replaced with coarse enums/codes, or truncated to a
   non-instruction-safe summary that cannot carry secrets/prompt payloads. Lock tokens, bearer
   tokens, credentials, secret refs, env maps, prompts, tool dumps, and raw supervisor records
   are never copied.

Canary tests inject distinctive secrets (`CANARY_SECRET_…`) and prompt-like strings into every
source object and assert absence from JSON stringification, human output, and error paths.

**Rejected:** Hopeful redaction regex alone.  
**Rejected:** Shipping the loop store status JSON with a denylist filter only.

### Decision 4 — Independent heartbeat cadence owned by the controller process

**Chosen:** While the controller holds the run and is not terminal, a heartbeat refresher
advances `heartbeat_at` on a bounded cadence (config default e.g. tens of seconds — exact default
chosen at implement time and unit-tested) even when a whole-item dispatch, expected wait sleep, or
recovery backoff is in progress. Cadence does **not** require model/worker progress messages.

Refresh **stops** after lock loss or terminal exit. If persistence of the heartbeat fails, health
MUST surface that failure (not report healthy liveness).

**Compose with** existing cycle-bound process-identity heartbeat: independent cadence is additive
evidence for liveness during long cycles; cycle completion may still refresh as today.

**Rejected:** Relying only on cycle-end heartbeat (current gap).  
**Rejected:** Inferring liveness from model tool heartbeats alone.

**Why.** Issue acceptance requires distinguishing live-but-busy from dead, without model chatter.

### Decision 5 — Three independent health dimensions + closed classification rules

**Chosen:**

| Dimension | Meaning | Evidence |
| --- | --- | --- |
| Process liveness | Controller process appears alive | Fresh heartbeat + same-host pid/service probe |
| Durable progress | Workflow state advanced | Ledger/event/action durable deltas timestamps |
| Expected waiting | Intentionally waiting | Recorded wait kind + deadline (CI, provider cooldown, backoff, dependency, capacity, human) |

Derived coarse controller health (for operators):

- **healthy / waiting:** live process; either recent durable progress **or** expected wait not past deadline
- **`suspected_stuck`:** fresh controller liveness **AND** an **explicitly started** operation past its deadline **AND** no durable progress since operation start
- **`dead`:** stale heartbeat **AND** same-host process/service absence proof
- **`unknown`:** cross-host holder, missing probes, missing heartbeat, or insufficient evidence — never upgraded to `dead`

**Rejected:** Single boolean "alive" that conflates wait and wedge.  
**Rejected:** Time-since-last-event alone as stuck (false positives on long legal waits).

### Decision 6 — Cost and telemetry honesty

**Chosen:** Cost coverage is tri-state per scope: `actual` | `estimated` | `unknown`. Missing
telemetry or accounting MUST remain `unknown`. The assembler MUST NOT emit remaining-quota
percentages or invent `0` cost from absence.

**Rejected:** Filling zeros for prettier dashboards.

### Decision 7 — #890 dependency: degrade gracefully without the macro-controller

**Chosen:** When #890 controller/service records exist, the snapshot fills controller identity,
mode/revision, active contract, and coarse phase from them. When absent/disabled, those fields
are explicit `unknown` / `legacy` / `not_applicable` and the loop supervisor + durable store remain
the primary live sources. Status never invents a macro-controller that is not running.

**Rejected:** Blocking #891 implementation entirely until #890 lands in production (planning can
precede; implementation may stage against seams and fakes of #890 shapes).

### Decision 8 — CLI registration and docs

**Chosen:** Register under the factory command family (e.g. `pipeline factory status` with
`--json`), `mutatesGitHub: false`, tight `allowedFlags`. Human output is a concise projection of
the same allowlisted model (not a second unsanitized path). Generated CLI docs / host skills /
`plugin/` regenerate as usual.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| #890 shapes not yet stable | Status seams take a narrow interface; fakes in tests; unknown attribution when missing |
| Over-sanitization removes useful operator text | Prefer coarse codes + short allowlisted summaries; keep full detail in existing audit/logs surfaces |
| Independent heartbeat write contention with ledger | Heartbeat writes only process-identity / health evidence under existing store rules; no ledger mutation from status or from heartbeat alone beyond process record |
| False `suspected_stuck` if deadlines are missing | Stuck requires **explicit** operation start + deadline; no deadline → cannot be stuck by that rule |
| False `dead` on cross-host | Hard rule: cross-host → `unknown` only |
| Canary tests miss a new source | Test harness enumerates registered source keys; adding a source without canary fails the suite |

## Migration Plan

1. Land allowlisted assembler + CLI behind pure readers of existing loop/supervisor/pin sources.
2. Add independent heartbeat to the active controller process path (supervisor now; #890 controller when available).
3. Extend snapshot fields as #890 evidence appears (additive within schema_version `"1"` when optional).
4. No migration of historical runs required; missing fields → unknown/legacy.
5. Rollback: remove command registration; heartbeat remains additive and non-authoritative for scheduling if temporarily disabled.

## Open Questions

1. Exact CLI spelling if the registry already nests factory subcommands differently
   (`factory status` vs `factory-status`) — resolve against current `COMMAND_REGISTRY` / Commander
   tree at implement time without changing semantics of this proposal.
2. Default independent heartbeat interval — pick a bounded default and document; make injectable
   for tests.
3. Whether human output is always derived solely from the JSON model (preferred) or may add
   non-machine decorations that still pass canary tests — prefer derive-from-model only.
