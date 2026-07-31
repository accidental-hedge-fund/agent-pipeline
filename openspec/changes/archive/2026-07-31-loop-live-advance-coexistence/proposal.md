## Why

Dogfood loop `loop-83023252d7fd8598` (v1.29.2) died with **`run_fatal` / `workflow-engine-defect`** after partial success: items were parked `hold-for-human`, an operator cleared `pipeline:blocked` on **#675** while a **separate operator advance was still live**, reconcile re-admitted #675, a second dispatch failed in ~5s on the host-local lock (`already running`), and the supervisor classed that as a genuine engine defect — stopping the whole multi-item run and stranding siblings that were already `ready` (e.g. #754).

That is a factory concurrency bug, not a product defect on the item: **double-dispatch must not kill the multi-item run**. Operator `/pipeline N` and the loop supervisor must coexist on the same host for the same issue.

## What Changes

- **Pre-dispatch live-advance coexistence check.** Before the loop dispatches a full advance for an item, if a host-local advance is already live for that issue (per-issue lock / active run-store / wrapper PID evidence), the loop SHALL **attach, skip, or wait** — it SHALL NOT record a terminal `failed` outcome that escalates to `run_fatal`.
- **Non-fatal mapping for lock / already-running / install-in-progress outcomes.** When a dispatch still collides and returns evidence of lock held, already running, or install in progress, the supervisor SHALL classify that outcome as a **non-fatal** class under loop recovery policy (retryable wait, hold, or noop progress) — **never** default `workflow-engine-defect` / `run_fatal`.
- **Hold-clear re-admit gate.** Clearing GitHub `pipeline:blocked` alone SHALL NOT re-admit an item into the executable frontier when the loop already has a **live linked advance** for that item, unless the live run is proven terminal.
- **Durable event distinction.** Loop events MUST distinguish `already_running` / `lock_held` (and equivalent coexistence outcomes) from genuine engine defects so audit and recovery do not conflate them.
- **No genuine-defect regression.** Rejected or crashed dispatches with no lock/already-running evidence, and unrecognized terminal outcomes without coexistence evidence, remain `workflow-engine-defect` with existing `run_fatal` policy.

## Acceptance criteria

- [ ] When an item is waiting under a needs-human hold, the `pipeline:blocked` label is cleared, and a host-local advance is still live for that issue, hold-clear reconciliation does **not** re-admit the item into a second full dispatch that can fail fatally on the lock.
- [ ] When the loop would otherwise dispatch an item whose host-local advance is already live, it attaches, skips, or waits — and records a non-fatal progress/wait outcome — rather than spawning a second advance that collides.
- [ ] A dispatch outcome classified `failed` that carries lock-held / already-running / install-in-progress evidence is **not** mapped to `workflow-engine-defect` / `run_fatal` and does **not** stop the whole multi-item run.
- [ ] Durable loop events distinguish `already_running` / `lock_held` (or equivalent coexistence markers) from genuine engine defects on the event trail.
- [ ] A genuine engine crash or rejected dispatch with **no** lock/already-running evidence still escalates as `workflow-engine-defect` / `run_fatal` per existing policy.
- [ ] Unit / supervisor tests cover: (1) hold cleared + live advance → no fatal double-dispatch; (2) failed+lock evidence → non-fatal; (3) genuine defect still run_fatal. Tests use injected seams (no real network, git, or subprocess).
- [ ] Dogfood-compatible coexistence: operator `/pipeline N` and the loop supervisor can run for the same issue on one host without the loop stopping the multi-item run solely because of that coexistence.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-live-advance-coexistence`: host-local coexistence between loop dispatch and an already-live per-issue advance — pre-dispatch attach/skip/wait, non-fatal lock/already-running outcome mapping, hold-clear re-admit gate while a live linked advance exists, and durable events that distinguish coexistence collisions from engine defects.

### Modified Capabilities

- `loop-blocked-item-hold-continuation`: refine the “held item re-enters the frontier when a human clears `pipeline:blocked`” path so re-admission is withheld while a live linked advance for that item is still non-terminal.
- `durable-loop-supervisor`: refine Pass-2 / failed-outcome classification so lock-held / already-running / install-in-progress evidence is non-fatal coexistence handling, not an unconditional `workflow-engine-defect` run stop.

## Impact

- `core/scripts/loop/supervisor.ts` — hold-clear re-admit (`reopenClearedBlockedHolds` / frontier selection), pre-dispatch live-advance probe, and Pass-2 failed-outcome safety net for lock/already-running evidence.
- `core/scripts/loop/` dispatch / execution seam (and any thin helpers used to detect host-local locks, active run-store identity, or wrapper PID liveness) — injectable so unit tests never touch real locks or subprocesses.
- Durable loop events / action-evidence trail — new or refined event types or outcome fields for `already_running` / `lock_held` (names may be normalized in design).
- Recovery / classification path that currently maps unrecognized `failed` → `workflow-engine-defect` / `run_fatal` — coexistence evidence MUST short-circuit before that default.
- Tests under `core/test/loop-supervisor.test.ts` (and co-located helpers as needed).
- Host-local concurrency scope unchanged (#459): no cross-host distributed lock; single-host remains the supported scope for these lock sites.
- Out of scope: cross-host locks; product review ceiling / #675 merge findings themselves; auto-merge.
