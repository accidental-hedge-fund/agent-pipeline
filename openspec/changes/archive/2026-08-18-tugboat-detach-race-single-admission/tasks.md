## 1. Confirm the concurrent admission hole

- [x] 1.1 Reproduce the #1109 fixture locally: two overlapping `tugboat --detach` for one unique milestone, using the existing `detach race (#1062 R2)` test or the same two-spawn shape.
- [x] 1.2 Confirm `try_acquire_detach_gate` can admit two holders (empty `detach.gate/pid` treated as stale, or any other reclaim that races the winner’s identity publish).

## 2. Serialize probe-and-spawn (flock protocol)

- [x] 2.1 Replace `mkdir` `detach.gate` with a regular lock file + exclusive `flock`. Acquire is atomic. Do not reclaim on “pid file empty right now.”
- [x] 2.2 Path is `$STATE_ROOT/admission/<repo-token>/v<safe-milestone>.lock`. `repo-token` is a stable hash of pinned `REPO_DIR` realpath. Milestone uses `safe_of`. Path does not depend on `pwd`.
- [x] 2.3 After acquire, write owner `pid` + starttime (when readable) into the lock file. Flock is the mutex; the write is identity only.
- [x] 2.4 Loser blocks on `flock -w` (documented timeout). After acquire it re-probes with `live_ship_probe`. Lock/file presence is not “already running.”
- [x] 2.5 Winner holds flock until `live_ship_probe` sees the detached child (or the wait bound expires). Emit `detached tugboat ship` only after that probe succeeds. Do not release immediately after `nohup`.
- [x] 2.6 `trap` on `EXIT` / `INT` / `TERM` (and `RETURN` if function-scoped, matching `ship_one`) reaps any still-unconfirmed child (recorded process group and session) then releases flock. Process death also drops flock.
- [x] 2.7 Stale leftover file with no live flock holder, or a dead owner pid, is reclaimable. A crashed winner must not permanently block a later detach.
- [x] 2.8 If spawn fails or the wait-for-live bound expires with no live ship: do not print `detached tugboat ship`. If a child was spawned, terminate and reap it (including any process group it created) before releasing admission. Then release, fail closed. A later `--detach` can proceed and cannot race a delayed first child.
- [x] 2.9 If `flock` is missing: fail closed. Do not fall back to the empty-pid mkdir gate.
- [x] 2.10 Preserve sequential #1062 behavior: live train `--merge` / owning tugboat still refuses; bare `playbook.pid` + `kill -0`, issue-run lock, and stale `state.json` still do not refuse.

## 3. Keep and harden the concurrent fixture

- [x] 3.1 Keep `core/test/tugboat.test.ts` `detach race (#1062 R2): concurrent Ship detaches exactly once`. Do not delete, skip, or mark it flaky.
- [x] 3.2 Keep two real `tugboat --detach` processes. Unique `9.99.*` milestone, isolated state dir and `REPO_DIR`, reap stubs in `finally`.
- [x] 3.3 Start both children through a test-only barrier/stub: wait until both are ready, release both, then wait for both exits. Assert on combined stdout+stderr. Do not use a sleep-only pass condition.
- [x] 3.4 Success fixture: both exit 0, exactly one `detached tugboat ship` line, exactly one already-running / not-detaching line.
- [x] 3.5 Prove the assertion still bites: the same two-spawn fixture fails when both outputs contain `detached tugboat ship`.

## 4. Extra admission regressions

- [x] 4.1 Concurrent fixture (or a sibling) proves the loser waited and then refused after the winner became live (already-running line, not lock-presence wording).
- [x] 4.2 Sequential `--detach` succeeds when a leftover admission lock file exists with a dead or absent owner and no live flock (stale artifact is not a live ship).
- [x] 4.3 After failed spawn or expired wait-for-live (lock released / process dead), a later `--detach` for the same repo+milestone can acquire and detach.
- [x] 4.4 Do not weaken existing #1062 negative cases (bare pid, pipeline lock, stale `state.json`). Keep those tests; add the admission-lock cases separately.
- [x] 4.5 Wait-for-live expiry with an already-spawned delayed child: first `--detach` fails closed and reaps; a later `--detach` admits exactly one live ship.
- [x] 4.6 SIGTERM during wait-for-live reaps the pending child before unlock. A child that forks a new process group and exits is still reaped via the recorded session.

## 5. Docs and OpenSpec

- [x] 5.1 Update `docs/runbooks/ship-milestone.md` if the gate artifact name or already-running line changes. State that refuse is still the live-ship probe.
- [x] 5.2 Keep this change’s `tugboat-thin-ship` delta aligned with the flock protocol, hold-until-live, cleanup, and fixture barrier.

## 6. Validate and CI

- [x] 6.1 Run `openspec validate tugboat-detach-race-single-admission` and fix structural errors.
- [x] 6.2 Run the tugboat tests (`cd core && node --test --experimental-strip-types test/tugboat.test.ts`).
- [x] 6.3 If any file under `core/` changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 6.4 Run `npm run ci` from the repo root and leave it green.
