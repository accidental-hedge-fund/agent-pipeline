## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` pack-fail includes "wait-budget exhaustion while
  status stays `in_progress`". Tugboat implements that as a `for` loop over
  `FRG_WAIT_ATTEMPTS` (default copied from `RELEASE_WAIT_ATTEMPTS=30`) with
  `FRG_WAIT_SLEEP_S` (default `RELEASE_WAIT_SLEEP_S=40`). After the last
  `retry` tick it writes `state.json` `frg-pack` / `failed` with
  `FRG pack still in_progress within wait budget` and `exit 1`.
- `classify_frg_pack_tick` already prints `retry` for bare `in_progress`.
  The defect is the wait **loop stop**, not the tick classifier.
- In-engine `pipeline ship` (`ship-adapter.ts`) copies the same class:
  `FRG_WAIT_ATTEMPTS=120` × `FRG_WAIT_MS=10_000` = 20 minutes, then throws
  "retry the same ship command to resume the bound pack".
- Prepare already returns `status: "in_progress"` with bound `loop_run_id`
  while the request-bound pack loop is not terminal (`release-sub-command`,
  `factory-reliability-gate`). Durable loop state lives under the run dir:
  `lock.json` (pid) and `ledger.json` / events (`loop_run_complete` /
  `loop_run_stopped` are terminal).
- The v1.39.5 site: wait expired at 19:16Z; loop pid `3986527` still alive;
  pack wall ~47 minutes to `loop_run_complete`.

**Conflict (do not average):** #1039 / #1133 pack-fail law treats wait-budget
exhaustion on `in_progress` as terminal ship fail. Issue #1150 says that
expiry SHALL NOT fail the ship while the bound pack loop is live. This
change supersedes that wait-fail clause for the live-loop case. CI wait
(`RELEASE_WAIT_*`) stays a CI poll.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat `Ship milestone v1.39.5` attempt
   cap 30×40s against bound loop `loop-c6abf57f55524c81`. The class is: a
   ship-path FRG pack composer that copies a CI-length poll cap and treats
   expiry as terminal ship fail while the bound factory-gate pack loop is
   still live.
2. **Shared surfaces.** Live-loop wait law in `tugboat-thin-ship`,
   `supervisor-ship-playbook`, `factory-reliability-gate`, and
   `ship-coordinator`. Shared liveness predicate (lock pid alive **or**
   ledger not terminal). Tugboat wait loop + heartbeat `write_state`.
   In-engine ship-adapter FRG wait. Helpers stay in sync. No new
   human-authority class: short wait expiry is an engine compose defect,
   not `needs-human`.
3. **Next identical fault.** Any later 2-item (or longer) factory-gate pack
   that exceeds 20 minutes still packs, because composers wait until the
   bound loop is terminal (or a real pack-fail). Tests fail if
   `in_progress` plus live bound loop is classified as terminal fail after
   N short sleeps. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Wait-until-terminal while the bound pack loop is live.
- Heartbeat so `state.json` stays `frg-pack` / `running` (Buzz does not see
  failed for wait expiry).
- Same class on Tugboat and in-engine `pipeline ship`.
- Keep Tugboat a thin composer of existing CLI verbs.
- Keep real pack-fail fail-closed.

**Non-Goals:**

- Raising the implementer 2400s cap.
- `--skip-frg` as the ship path.
- Killing the pack loop when a composer poll cap hits.
- Changing CI / release-PR check wait (`RELEASE_WAIT_*`).
- Fixing the unsigned `pass: false` classify hole from a later re-detach.
- A second pack runner, grant factory, or durable outer FRG ledger.

## Decisions

### 1. Wait-until-terminal while live; do not only raise the default cap

**Choice:** While prepare status is `in_progress` and the bound pack loop is
live, the composer SHALL keep re-invoking the same request and SHALL NOT
apply the numeric attempt cap as pack-fail. Heartbeat each tick. A numeric
`FRG_WAIT_ATTEMPTS` cap MAY remain only for the case where the bound loop
is **not** live (pid dead **and** ledger terminal or missing). Sleep
interval (`FRG_WAIT_SLEEP_S`) stays the heartbeat cadence. Default FRG wait
SHALL NOT copy `RELEASE_WAIT_*` as the live-loop stop.

**Why:** A 2-item factory-gate pack took ~47 minutes. A later pack can take
longer. Raising the default to 240×60s is still a mole. Wait-until-terminal
is the class fix. CI wait stays 20 minutes because CI is a poll, not an
advance loop.

**Alternatives considered:**

- Raise default `FRG_WAIT_ATTEMPTS` / `FRG_WAIT_SLEEP_S` to hours and keep
  expiry as fail → rejected; the next slower pack still fails the ship.
- Env-only override (`FRG_WAIT_ATTEMPTS=240`) as the product → rejected;
  that is the human re-detach path from the incident.
- Infinite wait even when the loop is dead → rejected; a dead loop plus
  stuck `in_progress` must still fail closed after a short dead-loop budget.

### 2. Shared liveness predicate: lock pid alive OR ledger not terminal

**Choice:** The bound pack loop is **live** when either:

- the durable loop run `lock.json` for that `loop_run_id` has a pid that is
  still alive (`kill -0` / equivalent), or
- the bound loop ledger / events are not terminal (`loop_run_complete` /
  `loop_run_stopped` / equivalent `run_complete` absent).

The bound `loop_run_id` comes from the prepare result (same source as the
attestor child). The composer SHALL NOT kill that pid.

The bound loop is **not live** when the lock pid is dead or missing **and**
the ledger is terminal or missing. Wait-budget expiry MAY then be pack-fail.

Prepare `in_progress` alone SHALL keep the tick as retry. It SHALL NOT by
itself authorize wait-fail. Liveness decides whether the attempt cap can
stop the wait.

**Why:** The incident had prepare `in_progress` and a live lock pid after
Tugboat died. Either signal is enough to keep waiting. Both-absent is the
dead-loop fail path.

**Alternatives considered:**

- Treat any `in_progress` as live forever → rejected; a crashed loop that
  still returns `in_progress` would hang the ship.
- Require lock pid only → rejected; a brief pid gap during supervisor
  restart would fail the ship while the ledger is still non-terminal.
- Require ledger only → weaker for the incident (lock pid was the live
  proof after Tugboat exited). Use OR.

### 3. Heartbeat is `write_state` running, not a new ledger

**Choice:** Each live-loop wait tick SHALL rewrite Tugboat `state.json`
with `phase: "frg-pack"` and `status: "running"` (updated `updated_at` and
a wait detail such as attempt / `loop_run_id`). Log a heartbeat line.
Do not add a second durable FRG wait ledger. In-engine ship SHALL keep its
ship ledger FRG phase running on the same rule.

**Why:** Buzz reads `state.json`. A silent sleep with stale `updated_at`
looks dead. Failed wait today is what Buzz saw. Heartbeat is the existing
`write_state` seam.

**Alternatives considered:**

- Notify-only without rewriting state → rejected; status readers use
  `state.json`.
- New wait ledger → rejected; Tugboat stays thin.

### 4. One wait law in helpers; Tugboat and ship-adapter both obey

**Choice:** Extract a small wait-continue vs wait-fail decision (tick
verdict + liveness + attempt cap) so a unit test can fail if
`in_progress` + live is terminal fail after N short sleeps. Tugboat and
`frg-pack-helpers.sh` stay in sync if the helper is shared. Ship-adapter
applies the same law in TypeScript (same inputs, no live pack).

**Why:** Class-over-site. A Tugboat-only mole leaves in-engine ship on the
20-minute "re-invoke to resume" path.

**Alternatives considered:**

- Tugboat-only because Buzz uses Tugboat today → rejected; constitution
  class-over-site. ship-adapter already has the same 20-minute cap.
- Raise ship-adapter attempts independently → rejected; that is two moles.

## Risks / Trade-offs

- **[Risk] Infinite wait if liveness is wrong-positive** → **Mitigation:**
  live requires lock pid alive or ledger not terminal. Pack loop still has
  its own bounds (item stages, implementer cap). Composer does not add a
  second implementer timeout. Dead-loop path still fail-closes.
- **[Risk] Existing tests set `FRG_WAIT_ATTEMPTS=1` to fail fast** →
  **Mitigation:** the cap still applies when the bound loop is not live.
  Those fixtures do not inject a live lock/ledger, so they still fail
  closed. The new regression injects live liveness and asserts continue.
- **[Risk] Heartbeat without a test-side stop hangs the spawn test** →
  **Mitigation:** the required test classifies wait-continue vs wait-fail
  after N short sleeps; it does not require an unbounded live `tugboat.sh`
  spawn. Optional spawn tests MUST inject a pack-done or not-live signal.
- **[Risk] CI wait accidentally inherits the new FRG wait** → **Mitigation:**
  `RELEASE_WAIT_*` stays the CI poll. Spec and code keep FRG wait on a
  distinct live-loop rule.

## Migration Plan

- Land the wait law and tests in the same change as the Tugboat /
  ship-adapter edit.
- No operator flag. No `--skip-frg`. No re-detach instruction as the
  product path.
- Rollback is revert of the change; old 20-minute fail returns.

## Open Questions

None. Wait-until-terminal vs hours-cap is resolved (Decision 1). Liveness
is the issue's OR predicate (Decision 2).
