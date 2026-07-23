## Context

The durable loop engine (#508–#511) already owns every piece of durable *state* a run needs:
contract compilation and canonical identity (`durable-loop-engine`), the run directory / atomic
writes / append-only logs / exclusive lock with liveness-based staleness (`durable-loop-store`),
typed blocker classification and recovery (`durable-blocker-classification`), durable paused/waiting
holds and audited authority amendments (`durable-pause-and-authority`), and verified live
reconciliation with typed drift and per-item next actions (`durable-run-reconciliation`). The
`pipeline-loop-facade` capability already fixes the *command surface* (`--milestone/--label/--range/
--roadmap-slice`, an issue list, `--resume`, `--audit`), the native-`/goal` capability probe, the
`pipeline/loop-execution@1` hand-off contract, and the rule that all durable state is delegated to
the in-repo engine.

What is still missing — and what #512 supplies — is the *driver*: the process that actually consumes
those primitives to run a whole run to completion, plus the small amount of durable state that
belongs to the driver rather than to the run's items. Today `pipeline loop` runs preflight and then
prints a delegation payload for the host `SKILL.md` to invoke an external goal-loop skill, and
`loop-preflight.ts` still discovers that external install. That external facade is the thing being
replaced.

## Goals / Non-Goals

**Goals**
- One in-repo supervisor runtime that drives a compiled, locked run cycle-by-cycle to a terminal
  condition, using only the existing engine primitives.
- Persist the driver's own durable state — process identity + heartbeat, a run-level no-progress
  watchdog, and an append-only action-evidence trail — in the *same* run directory.
- Safe resume/takeover of a run whose supervisor is provably gone, and a substantive read-only audit.

**Non-Goals**
- No new per-item advance behavior. The supervisor hands off whole items via `pipeline/loop-execution@1`
  and never learns how a stage advances (a stated engine invariant).
- No merge/release/deploy by the supervisor (golden rule #4).
- No cross-host mutual exclusion beyond the store's existing host-local guarantee (#459). Cross-host
  liveness stays "unverifiable → not recoverable."
- No new run-id namespace, ledger, lock, or store.

## Decisions

### Decision 1 — Process identity is a *separate* artifact from the lock

`lock.json` answers "who may write" and already carries `pid`/`hostname`/`token`. But the watchdog
needs a signal the lock does not provide: whether the holder is *making progress*, not merely alive.
A live pid can hold the lock while wedged inside a per-item execution that never returns. So the
supervisor writes a distinct `supervisor.json` process-identity record — same directory, refreshed
every cycle with a monotonic `heartbeat_at`. The lock stays the single write-authority; the process
record is diagnostic/liveness state read by resume and audit. This avoids overloading the lock's
recovery semantics (which are deliberately conservative: recover only a same-host dead pid).

### Decision 2 — Two independent no-progress bounds, deliberately not merged

`loop/recovery.ts` already bounds *item-level* repeated no-progress (identical evidence fingerprint
on the same blocked item → `repeated_no_progress` stop). #512 adds a *run-level cycle* watchdog: a
whole supervisor cycle that yields no durable delta (no transition, no reconciliation change, no
recovery attempt, no new hold, no stop). These catch different failures — a single item stuck on
identical evidence vs. the driver spinning with nothing eligible to do — and are kept as two separate
bounds so neither can mask the other. The run-level stop uses its own reason
(`supervisor_no_progress`) so audit and the stop record stay unambiguous.

### Decision 3 — Progress is defined as a durable delta, computed from engine writes

Rather than have the supervisor guess whether it "did something," a cycle counts as progress iff it
produced at least one durable delta observable in the run directory: an item state transition, a
reconciliation sequence bump / new drift, a recorded recovery attempt, a new paused/waiting hold, or
a stop. This keeps the watchdog honest (it can't be fooled by a cycle that logs but changes nothing)
and makes the action-evidence `progress` classification a pure function of what was written.

### Decision 4 — Resume reuses the store's provably-dead recovery, never invents a new liveness rule

Resume/takeover is exactly the store's existing `classifyStaleness` → `recoverLock` path: a released
lock is acquirable; a same-host dead-pid lock is recoverable; a live same-host holder or a
cross-host (`unverifiable_cross_host`) holder is refused. #512 adds nothing to the liveness rule — it
only adds the *post-recovery* obligations: run one reconciliation pass before continuing (so the
resuming process acts on verified live truth, not the pre-crash ledger), and append a resume marker
to the action-evidence trail. A hung-but-alive supervisor is intentionally *not* auto-killed:
the operator terminates it (→ dead pid → recoverable), which keeps us inside the store's safety
invariant and the single-host concurrency scope (#459).

### Decision 5 — Audit is a pure projection over persisted artifacts

`--audit` reads `contract.json` / `ledger.json` / `supervisor.json` / `action-evidence.jsonl` and the
existing status projection, and renders them. It acquires no lock, writes no record, and makes no
`gh` call — matching the facade's read-only audit invariant. A run with no `supervisor.json` yet
(pre-#512, or never attached) audits cleanly with the process identity reported absent. Because audit
touches no lock, it is safe to run against a run another process is actively driving.

### Decision 6 — Retire external discovery, keep legacy *import*

The run-start preflight's `loop:contract-coherence` check (which discovers an installed goal-loop
skill via `.goal-loop-manifest.json` / `state.py`) is replaced by the in-repo durable loop store's
schema-compatibility check, per the already-living `pipeline-loop-facade` requirement "The preflight
SHALL NOT check for, discover, or require an externally installed goal-loop skill." This is a
code-catch-up to a spec that already ships. The read-only legacy-run *import* path
(`loop/import.ts` + the `goal-loop-run-import` capability) is untouched: a pre-existing legacy run
stays addressable by `--resume <run-id>`.

## Risks / Trade-offs

- **A wedged-but-alive supervisor blocks resume until an operator kills it.** Accepted: auto-killing
  another live process is exactly the cross-process action #459 scopes out; the heartbeat/action-
  evidence trail makes the wedge diagnosable, and the fix (terminate → dead pid → recover) is one step.
- **Two no-progress bounds add a second tuning knob.** Accepted: merging them would let an item-level
  stall hide a driver spin (or vice-versa); the separation is the safer default and both have
  documented defaults.
- **Audit reading a run mid-drive can show a slightly stale frame.** Accepted: audit is defined as a
  lock-free projection; a momentarily stale heartbeat/position is preferable to audit taking a lock and
  perturbing a live run.

## Migration / Interoperability

Purely additive to the run directory. A pre-#512 run has no `supervisor.json` and no
`action-evidence.jsonl`; audit reports the process identity absent and shows whatever the ledger and
events already hold, and resume writes the new artifacts on first attach. No ledger field is removed
or retyped. No new external write path; no auto-merge/release/deploy.
