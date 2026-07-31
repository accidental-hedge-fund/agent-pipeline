# Design

## Context

Root-cause trace for dogfood loop `loop-83023252d7fd8598` (item #675):

1. Loop parked items under needs-human holds (`pipeline:blocked` / hold-for-human).
2. Operator resume/unblock cleared `pipeline:blocked` on #675 while a **separate** operator advance was still live (mid review-2 / fix-2).
3. Supervisor reconciliation (`reopenClearedBlockedHolds`) saw the blocked label gone and re-admitted #675 to `pending` with event `loop_item_hold_cleared` — **without checking whether a host-local advance was still live**.
4. Next cycle selected #675 and dispatched a new advance (`675-2026-07-31T16-16-07-174Z`). That attempt failed in ~5s; no durable advance run dir survived — consistent with the per-issue lock handshake rejecting concurrent launch (`pipeline: issue #N is already running`, `.lock-failed` in detach).
5. Supervisor Pass 2 classed the dispatch as `failed` → default `workflow-engine-defect` → policy `run_fatal` → `loop_run_stopped` reason `run_fatal`, with `outstanding_ready: ["754"]` stranded.

This is the next sibling of the Pass-2 misclassification family (#568 precondition no-op, #570 needs-human blocker, #581 already-blocked hold continuation): **coexistence with a live host-local advance must never look like an engine defect.**

Constraints:

- Per-issue advance locks (`lock.ts` / detach handshake) are **host-local** (#459). Cross-host distributed locks remain out of scope.
- Loop already publishes real advance run-store linkage (`loop-dispatch-advance-linkage`) when *it* owns a dispatch; operator-launched advances may exist outside that linkage and must still be detectable via host-local lock / run-store / wrapper PID evidence.
- Pipeline never merges; human owns merge and unblock (CLAUDE.md golden rule #4).
- Unit tests inject I/O seams — no real network, git, or subprocess.

## Goals / Non-Goals

**Goals:**

- Operator `/pipeline N` and loop supervisor coexist on one host for the same issue without stopping the multi-item run.
- Hold-clear re-admission is gated by live-advance liveness, not only by absence of `pipeline:blocked`.
- Pre-dispatch (and post-dispatch failed) paths treat lock/already-running as non-fatal coexistence.
- Durable events distinguish coexistence collisions from engine defects.
- Genuine defects without coexistence evidence remain run_fatal.

**Non-Goals:**

- Cross-host distributed locks or cross-host advance ownership.
- Changing product review ceilings or #675 merge findings.
- Auto-merge or auto-unblock of GitHub labels.
- Expanding multi-item concurrent dispatch (`max_active_items: 1` stays).
- Owning or killing an operator’s advance process from the loop.

## Decisions

### Decision 1 — Prefer prevent-dispatch over post-hoc reclassification (defense in depth)

Two independent defects produce the dogfood failure:

- **(A) Re-admit without live-advance gate.** Hold clear alone re-admits to the frontier.
- **(B) Failed lock collision → run_fatal.** Pass 2 treats any non-blocked `failed` as `workflow-engine-defect`.

We fix both:

1. **Primary:** before selecting/dispatching (and when reopening holds), probe host-local “is an advance already live for this issue?”; if yes, do not start a second full dispatch.
2. **Safety net:** if a dispatch still returns lock/already-running evidence, map to non-fatal coexistence handling — never `workflow-engine-defect` / `run_fatal`.

This mirrors the #568/#570/#581 pattern: frontier gate first, Pass-2 safety net second.

### Decision 2 — Live-advance probe is an injectable host-local pure-enough seam

Define a small dependency-injected probe, conceptually:

```text
probeLiveAdvance(issueId) →
  { live: false } |
  { live: true, evidence: "lock_held" | "active_run_store" | "wrapper_pid",
    pipeline_run_id?: string, holder_pid?: number, events_path?: string }
```

Evidence sources (host-local only, best-effort union):

| Source | Meaning |
|--------|---------|
| Per-issue lock file with live PID | Another advance holds the advisory lock |
| Active advance run-store (non-terminal `events.jsonl` / sentinel not terminal) | Run dir proves work in flight |
| Wrapper / process record for that issue | Detached launcher still alive |

Rules:

- Probe is **host-local** and may return “not live” on another host even if work exists elsewhere — same documented #459 disposition as other `/tmp` locks.
- Probe MUST NOT invent a live path when no evidence exists.
- When loop already has start-linkage for a non-terminal advance on this item, that linkage alone is sufficient to treat the advance as live for re-admit / re-dispatch decisions.
- Unit tests inject the probe; production wires lock + run-store + optional PID checks.

**Terminal proof:** an advance is non-live only when there is no live lock holder **and** no non-terminal run-store evidence (sentinel/`run_complete`/equivalent terminal). Stale dead-PID locks follow existing lock reclaim rules and do not count as live.

### Decision 3 — Coexistence outcomes: attach / wait / skip — not blocked defect

When a live advance is detected for an item the loop would dispatch:

| Situation | Disposition |
|-----------|-------------|
| Loop has (or can resolve) linkage to the live run store | **Attach**: treat the item as still in flight under that run id; do not spawn a second advance; continue supervising/waiting for that advance’s terminal outcome through existing linkage/wait paths where available |
| Live evidence exists but no joinable run store | **Wait / skip cycle**: leave or move item to a non-terminal waiting/in-progress-coexistence state; re-probe next cycle; do not `run_fatal` |
| Dispatch returns lock/already-running / install-in-progress text or structured evidence | **Safety net**: same non-fatal wait/skip; emit coexistence event |

Explicitly **do not**:

- Create a new `DurableBlockerClass` solely for lock collisions (closed enum expansion is avoidable; this is not a product/workflow defect).
- Charge recovery budgets for coexistence waits (they are not recovery recipes).
- Kill or force-takeover the operator advance.

Progress classification: a successful attach/wait that records durable coexistence evidence **is progress** for the no-progress watchdog (prevents unbounded spin while still allowing re-probe). Pure no-op cycles with no new evidence remain subject to the existing consecutive-no-progress bound.

### Decision 4 — Hold-clear re-admit requires live advance to be terminal (or absent)

Refine `reopenClearedBlockedHolds` (capability `loop-blocked-item-hold-continuation`):

Current: `pipeline:blocked` absent → `waiting`/`paused` → `pending` + `loop_item_hold_cleared`.

New:

1. If `pipeline:blocked` still present → leave held (unchanged).
2. If label cleared **and** live-advance probe (or non-terminal loop linkage) says live → **keep held or move to coexistence-wait**, do **not** re-admit to executable dispatch frontier; emit a durable event that the hold was not fully cleared for dispatch (e.g. `loop_item_hold_clear_deferred` / coexistence note — exact name chosen in implementation, must be distinct from unconditional clear).
3. If label cleared **and** no live advance → re-admit as today + `loop_item_hold_cleared`.

This prevents the exact dogfood sequence: unblock while operator advance mid-flight → immediate second dispatch.

### Decision 5 — Pass-2 ordering: coexistence evidence before workflow-engine-defect

Extend the failed-branch ordering in supervisor Pass 2:

1. Genuine crash/rejection **without** coexistence evidence → `workflow-engine-defect` / `run_fatal` (unchanged).
2. Precondition no-op (#568) → non-fatal exclusion.
3. `pipeline:blocked` present (#570/#581) → needs-human hold.
4. **NEW:** lock-held / already-running / install-in-progress evidence (from dispatch error text, structured exit codes, `.lock-failed` handshake residue, or probe) → non-fatal coexistence wait/skip + durable coexistence event.
5. Otherwise → `workflow-engine-defect` / `run_fatal`.

Evidence matching MUST be deterministic and unit-tested (substring / structured codes injected via seams). Prefer structured signals from the dispatch seam when available; fall back to known lock-message patterns from `detach.ts` / `lock.ts` only as a last resort, documented in tests.

### Decision 6 — Durable events distinguish coexistence from defects

At minimum the loop run trail MUST be able to show:

- that coexistence was detected (`already_running` / `lock_held` / equivalent),
- which item,
- optional `pipeline_run_id` / holder pid when known,
- that the multi-item run did **not** stop for `run_fatal` solely due to that outcome.

Implementation may reuse or extend `loop_item_advance_*` linkage events rather than inventing a large event taxonomy; the requirement is audit distinguishability, not a specific event name set.

### Decision 7 — Relationship to existing capabilities

- `loop-blocked-item-hold-continuation`: re-admit scenario is MODIFIED (label clear is necessary but not sufficient while live advance exists).
- `durable-loop-supervisor`: failed outcome handling gains a coexistence branch; terminal-condition / max_active_items semantics unchanged.
- `loop-dispatch-advance-linkage`: unchanged requirements for when the loop *owns* a dispatch; coexistence may *consume* existing linkage when attaching to a known run id.
- `durable-blocker-classification`: no enum change planned; coexistence is not a `DurableBlockerClass` block.
- #459 cross-host scope: documented single-host remains.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Stale lock looks “live” forever | Use existing dead-PID reclaim; only live PIDs / non-terminal run stores count |
| Probe false negative → second dispatch | Pass-2 lock-evidence safety net still non-fatal |
| Probe false positive → item stuck waiting | Re-probe each cycle; no-progress watchdog still applies if no durable progress; operator can clear stale lock |
| Over-broad string match masks real defects | Prefer structured evidence; golden-string tests; genuine crash paths without match still run_fatal |
| Attach to operator run without full linkage | Wait/skip is allowed when join keys missing; do not invent events paths |

## Migration Plan

- Behavior change only; no ledger schema version bump required if coexistence state reuses `waiting`/`in_progress` + events (if a new hold source discriminator is added, keep it additive and backward-compatible for readers).
- No GitHub label changes.
- Ship behind normal pipeline change → PR → human merge; dogfood by running loop + manual `/pipeline N` on a held item.

## Open Questions

- Exact event type name(s) for deferred hold-clear vs coexistence wait (implementation choice; specs require distinguishability, not a fixed string set).
- Whether attach always reuses the existing child-wait path when `pipeline_run_id` is known, or only records linkage and re-enters on next cycle — either is acceptable if double-dispatch is avoided and the run is non-fatal.
