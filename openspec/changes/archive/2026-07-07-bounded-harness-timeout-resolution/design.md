# Design

## Context

`runCapped` returns a `Promise<HarnessResult>` that settles from exactly one of four
sources today:

1. `child.on("close")` — happy path and non-timeout exits (clears the timer, settles).
2. `child.on("error")` — spawn failure (`spawn_error`).
3. `child.stdout/stderr.on("error")` — capture stream break mid-run (`capture_error`, #384).
4. The timeout `setTimeout` chain — cap fires → SIGTERM → wait `killGraceSec` → SIGKILL →
   wait 200ms → `settle({ timed_out: true })`.

The failure mode in #398 is that **none of these fire**. A detached grandchild that survives
SIGKILL keeps the inherited stdout/stderr write-ends open, so the parent's read streams never
emit `close` (Node's `"close"` waits on stdio, not on the direct child's exit). Sources 1–3
are all child-event-driven, so they stay silent. Source 4 *should* settle via its innermost
200ms timer — but it is nested three callbacks deep inside the escalation chain, so resolution
is coupled to that chain running to completion. The engine version in the incident, or an
exotic timing/throw inside the chain, left the promise pending for 10 hours.

The fix must make resolution **independent** of both child events and the kill escalation —
per the issue's out-of-scope note, we do not diagnose *why* the tree survived SIGKILL; we make
`runCapped` conclude regardless.

## Decision 1 — Hard secondary deadline as the sole resolution guarantor

At the moment the wall-clock cap fires, arm one additional `setTimeout` — the **failsafe
deadline** — that calls `settle({ timed_out: true })` unconditionally after
`killGraceSec + hardDeadlineSec` (default `hardDeadlineSec = 30`, measured so it lands ~30s
after the SIGKILL point). It is:

- **Not cleared by any child event** — `close`/`error`/`capture-error` handlers do not touch it
  (they call `settle`, and `settle`'s `if (settled) return` idempotence means whichever fires
  first wins; the failsafe is a no-op if the child already concluded).
- **Not nested inside the escalation chain** — it is a sibling timer armed in the same tick as
  SIGTERM, so a throw or wedge anywhere in the grace→SIGKILL→200ms path cannot prevent it.
- **Injectable** — `opts.hardDeadlineSec` lets tests use a sub-second value; production keeps 30.

The existing escalation chain (SIGTERM → grace → SIGKILL → 200ms settle) is retained unchanged
for the common case where the group *does* die cleanly — that path settles first and the
failsafe never fires, so there is **no added latency** on normal timeouts. The failsafe only
matters when the escalation fails to conclude.

`settle` already guards against double-resolution and already removes the parent
SIGINT/SIGTERM listeners and forward-error listeners, so routing the failsafe through `settle`
needs no new teardown logic.

Rejected alternative — arming the failsafe at spawn time for the full `timeoutSec +
killGraceSec + hardDeadlineSec` window: functionally equivalent but couples the failsafe delay
to the cap value and complicates the injectable short-timeout tests. Arming it *when the cap
fires* keeps the secondary window a fixed, independently testable quantity.

## Decision 2 — Record `harness_timeout` at cap-fire time, not at resolution

The event must land **when the cap fires**, before and independent of the promise settling, so
a supervisor tailing `events.jsonl` sees the wedge even in the pathological case where
resolution is delayed. So the append happens in the cap `setTimeout` callback (alongside
SIGTERM), not after `runCapped` returns.

`runCapped` has no run-store context today. `invoke()` already carries
`opts.accounting.runDir` + `opts.accounting.runStoreDeps` for stage accounting; thread an
optional `timeoutEvent?: { runDir; deps?; stage; issue }` (or reuse the accounting shape) into
`runCapped` opts and, when present, `appendEvent(runDir, { type: "harness_timeout", ... },
deps)` from the cap callback. Delivery is **best-effort** (wrapped like the existing
`emitStageAccounting(...).catch(() => {})`) and entirely **absent for bare `runCapped`
callers** (`testgate.ts`, `eval.ts` paths that pass no run-store context) — those keep exactly
today's behavior. The event is additive; `schema_version` stays `1`, and `readEvents()` already
tolerates unknown types.

Event fields: `schema_version`, `type: "harness_timeout"`, `at`, `stage` (or `label`),
`timeout_sec`. `stage`/`label` is whatever `runCapped` already receives as its `label`
argument (harness name for the built-ins), refined to the stage name when the invocation
carries it.

## Decision 3 — `possibly_wedged` derived from event recency vs. largest stage timeout

The status envelope already computes `last_event`. Extend the same assembly to emit a
`possibly_wedged` object when **both**:

1. the run is **not finalized** — `events.jsonl` has no `run_complete` event, and
2. `now - last_event.at` exceeds the **largest configured stage timeout** (the max over the
   configured per-stage timeouts, e.g. `review_timeout` and the planning/implementing/fix
   caps), plus a small margin so a stage legitimately near its cap is not flagged.

Shape: `possibly_wedged: { last_event_age_ms: number, threshold_ms: number, last_event_type:
string } | null`. It is an **additive** field (envelope `schema_version` stays `"1"`) and
`null` whenever the run is finalized or recent. This keys off event *recency*, so the
`harness_timeout` event from Decision 2 refreshes the timeline the instant a cap fires — a run
that timed out but is escalating normally shows a fresh `harness_timeout` and is not flagged;
only a run that goes *silent* past the threshold trips `possibly_wedged`.

The status path already has the resolved config in scope, so the largest-timeout computation is
a pure helper over config with no new I/O. Doctor is intentionally left out of scope — the AC
allows "status *or* doctor," and status already owns per-issue run recency, keeping the change
focused.

## Testing

- **Harness resolution (bite test):** inject `spawnFn` returning a fake child whose `stdout`/
  `stderr` never emit `close`/`end` and whose `kill`/group-kill is a no-op; call `runCapped`
  with a short `timeoutSec`, `killGraceSec`, and `hardDeadlineSec`; assert the promise resolves
  `timed_out: true` within the secondary window. Without the failsafe timer the promise never
  settles and the test times out — proving the test bites.
- **Event recording:** inject run-store deps capturing appended events; assert a
  `harness_timeout` event is appended when the cap fires, with the expected fields, and that no
  such event is appended on a normal (pre-cap) exit.
- **Status wedge flag:** via the existing `deps` seam, feed a fake `events.jsonl` (unfinalized,
  stale last event) and assert `possibly_wedged` is populated; feed a finalized or fresh log and
  assert it is `null`. No real network/git/subprocess.
- **No-regression:** existing descendant-cleanup and non-timeout scenarios keep passing with the
  same `HarnessResult` shape and no added latency.
