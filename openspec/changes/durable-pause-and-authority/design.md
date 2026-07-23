## Context

The integrated durable loop engine (#508, capabilities `durable-loop-engine` / `durable-loop-store`)
already persists a per-item state machine, an append-only event log, and — unused until now — an
append-only **decision log** (`decisions.jsonl`, `appendDecision`). Typed blocker classification
(#509, `durable-blocker-classification`) added a closed failure taxonomy with recovery budgets and
fingerprint-bounded no-progress stops. Every non-recovery way the run currently reaches a human is a
*terminal stop* (`needs_human_classification`, `human_authority`) — the run ends.

goal-loop#2 (this issue, #510) ports the missing *non-terminal* human surfaces: durable
`paused`/`waiting` holds, a precise human-input request per wait, audited resume, scoped audited
authority amendments, and audited cross-engine handoff. This is a spec-only step; the decisions
below fix the contract the implementation will honor.

## Goals / Non-Goals

**Goals**
- `paused` / `waiting` as durable, non-failure holds cleanly separated from `blocked` (no budget,
  no block-count, no `DurableBlockerClass`).
- A structured, durable human-input request that a resume must satisfy — the audited counterpart to
  goal-loop's "precise human-input request".
- Scoped, audited authority amendments that widen a single `(gate, scope)` and nothing more, never
  bypassing the evidence mandate.
- Audited cross-engine handoff that composes with the existing lock and native-goal mandates.

**Non-Goals**
- No auto-merge / auto-release / auto-deploy path and no `auto_merge` config key (golden rule #4).
  An authority amendment authorizes *recording* a gated ledger transition a human performed; the
  engine still never performs a merge, release, or deploy itself.
- No change to the per-item advance state machine (labels, `BlockerKind`, `blocked-recovery-recipes`);
  this is the durable *run* engine, a distinct surface.
- No new failure class: every refusal on these surfaces reuses the existing taxonomy.
- No external reads; the engine keeps its injected-seam, no-network discipline.

## Decisions

### paused vs. waiting: both holds, only waiting carries a request
Both are durable non-failure item states admitted from `in_progress` and resumable to `in_progress`.
The distinction is intent: `paused` is a bare operator hold (no question outstanding); `waiting`
always carries a **precise human-input request** the run is blocked on. Modeling both — rather than
one state with an optional request — keeps status projections and audits legible (a `paused` run is
"deliberately held", a `waiting` run is "needs this specific answer") and makes "a waiting transition
without a request is refused" a clean validation invariant.

### Holds are not blocks — the separation is the point
`blocked` means a typed *failure* that consumes a recovery budget and counts toward the
consecutive-blocked stop limit. A hold is a *deliberate* pause. Reusing `blocked` would corrupt both
counters (a human pause would drain a class budget and could trip the consecutive-blocked stop). So
`paused`/`waiting` are separate states that explicitly charge no budget, count no block, and carry no
`DurableBlockerClass`. The `durable-loop-engine` consecutive-blocked requirement already counts only
"transitions into blocked", so it needs no change; only the transition-graph requirement is modified.

### The decision log is the audit substrate
Resume, authority amendment, and handoff are all recorded via the already-present `appendDecision`
(`decisions.jsonl`), which requires the lock holder's token and is append-only. The human-input
*request* lives on the ledger item (durable, part of the resumable hold); the human's *response*,
the amendment, and the handoff are decisions. This reuses existing store primitives rather than
adding a parallel record type, and keeps the "audited" guarantee identical to the store's other
append-only logs.

### Authority amendment widens `(gate, scope)`, nothing more — fail closed
The engine's authority requirement forbids objective text / selector / later input from widening a
grant. An audited amendment is the *one* sanctioned later-input path, and it is deliberately narrow:
exactly one gate, optionally one item scope. The gated-transition check becomes "compile-time grant
**or** matching amendment", default-deny otherwise. Critically the amendment is orthogonal to the
existing **directly-verified-evidence** requirement: an amendment authorizes *who may*, evidence
proves *that it happened* — a gated transition still needs both. This is why the change modifies the
authority-gate requirement (to add the amendment path) but leaves the evidence requirement untouched.

### Handoff releases, never transfers, the lock
A handoff mirrors `recoverLock`'s discipline: it removes the current lock via compare-and-delete and
records an audited decision, but never hands the token to the other engine. The receiving engine must
`acquireLock` fresh and re-attest native-goal mode. A handoff is refused while any item is
`in_progress` (conflict-class) so single-engine advance is never violated mid-work — the run must be
`paused`/`waiting` first. This composes the new surface with the store's existing lock and the
engine's native-goal mandate without weakening either.

## Risks / Trade-offs

- **Two hold states may look redundant.** Mitigation: the request-required invariant on `waiting`
  and the request-free `paused` give each a distinct, testable contract; collapsing them later is a
  spec change, not a data migration.
- **Authority amendments are a widening path** — the exact thing the engine was built to forbid
  implicitly. Mitigation: the path is audited (decision log), narrow (one gate, one scope),
  fail-closed (default-deny stands), and still gated on directly-verified evidence; every deny in the
  allow/deny matrix is a pinned test.
- **Decision-log-as-audit assumes append-only integrity.** Mitigation: `appendDecision` already
  requires the holder token and never rewrites bytes (capability `durable-loop-store`); no new
  integrity guarantee is introduced, only a new consumer.

## Migration

Additive. A pre-#510 run has no `paused`/`waiting` items, no outstanding requests, and no
amendments, so its behavior is byte-identical to today. No data-migration script is required; the new
records appear only once the new surfaces are exercised, and are delivered with the implementation
change, not this spec step.
