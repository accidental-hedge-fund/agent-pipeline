## Context

See proposal.md — Why. Option 1 detach lives in `examples/supervisor/shell/tugboat.sh`. #1062 made the live-ship probe the only refuse gate. A later R2 pass added `try_acquire_detach_gate` (`mkdir` of `ship-vX.Y.Z/detach.gate`) to serialize probe-and-spawn. `core/test/tugboat.test.ts` already has `detach race (#1062 R2): concurrent Ship detaches exactly once`. That test spawned two `--detach` processes on CI run `32075787450` and both printed `detached tugboat ship`.

Current constraints:

- Live-ship refuse must stay probe-based (train `--merge` or owning tugboat). Gate presence is not a live ship.
- Host-local PID / directory locks remain single-host. This change does not add a cross-host mutex.
- The concurrent test must stay. Do not skip it. Do not mark it flaky.
- Surgical: close concurrent admission. Do not rewrite the ship composer.

Likely hole in the current gate (to confirm during implementation, not a spec claim): after `mkdir` succeeds, the holder writes `detach.gate/pid` in a second step. A waiter that treats an empty pid as stale can `rm -rf` the gate and `mkdir` again. Both processes then believe they hold the gate.

## Goals / Non-Goals

**Goals:**

- Make overlapping `--detach` for one milestone admit exactly one ship on GitHub Actions, not only on a quiet local run.
- Keep refuse meaning = live-ship probe. Serialize the check; do not replace the probe with “gate exists.”
- Keep the two-spawn fixture and its bite: two `detached tugboat ship` lines fail the test.
- Prefer a product serialization that cannot lose to scheduler interleaving over a longer sleep in the test.

**Non-Goals:**

- Cross-host ship lock.
- Changing the live-ship definition, REPO_DIR pin, or status rewrite.
- Sibling recover: release-finish re-run of a failed check.
- Deleting, skipping, or quarantining the concurrent test.
- A second refuse heuristic in Hermes / chat.

## Decisions

### 1. Fix admission in Tugboat, not by weakening the test

- **Choice:** Close the race in `detach_self` / the per-milestone admission lock so two overlapping `--detach` processes cannot both pass not-live and both spawn. Keep the existing two-spawn fixture as the regression.
- **Why:** The CI failure is a real double detach, not a false-positive assertion. A sleep-only test pass would hide the product hole on a faster or slower runner.
- **Alternative:** Mark the test flaky / skip it — **rejected** (issue forbids this).
- **Alternative:** Delete the test — **rejected**.
- **Alternative:** Only add a sleep in the test and leave the gate as-is — **rejected** as the primary fix. A documented wait on the lock/gate file is allowed as extra determinism after admission is serialized.

### 2. Admission lock serializes probe-and-spawn; probe still decides refuse

- **Choice:** One process at a time may run live-ship probe + detach for a milestone. The winner holds the lock until the new ship is visible to the probe (or a short documented bound). The waiter re-probes after it acquires or after the winner releases, then takes the already-running path.
- **Why:** Matches #1062: gate presence is not a live ship. Sequential Ship after a live ship still refuses via probe. Bare pid / issue lock / stale state stay non-live.
- **Alternative:** Treat `detach.gate` existence as already-running — **rejected**; regresses #1062 (stale gate would block a real Ship).
- **Alternative:** Rely only on `live_ship_probe` without a lock — **rejected**; that is the TOCTOU that produced two detaches.

### 3. Acquire must be exclusive through the whole hold, including pid publish

- **Choice:** The admission primitive MUST NOT be reclaimable by a waiter while the holder is between exclusive create and identity publish. Empty-pid-as-immediately-stale + `rm -rf` of a just-created gate is not allowed. Prefer one of: `flock` on a lock file, atomic create that includes holder identity, or stale reclaim only after a bounded age plus dead holder — not on “pid file missing right now.”
- **Why:** The existing `mkdir` + later `pid` write is the most likely CI-only hole. Actions runs two bash processes in true parallel; a local `npm run ci` often does not hit the window.
- **Alternative:** Keep mkdir and add more `sleep 0.1` retries — **rejected**; still racy under empty-pid reclaim.
- **Alternative:** Write `playbook.pid` from the parent before spawn — **rejected** earlier in #1062 (parent/nohup pid let a second detach steal the ship lock). The admission gate is not `playbook.pid`.

### 4. Concurrent fixture stays two real spawns of Tugboat

- **Choice:** Keep `Promise.all` of two `bash tugboat --detach` processes, unique `9.99.<pid>.<time>` milestone, fake long-lived `PIPELINE`, isolated `PIPELINE_SUPERVISOR_STATE`. Assert exactly one `detached tugboat ship`. Assert the other path is already-running / not-detaching (or equivalent documented refuse). Both exit 0. Reap stubs in `finally`.
- **Why:** This is the fixture that failed on run `32075787450`. A source-only regex that `detach.gate` exists would not have caught the live double detach.
- **Allowed extra:** After spawn, wait on the documented gate/lock artifact (or on one process printing detach/refuse) before counting lines — not a bare `sleep` as the pass condition.
- **Alternative:** Replace the process fixture with static source assertions only — **rejected** as the sole check; keep source assertions that the gate helpers still exist if useful.

### 5. Scope stays Tugboat + tugboat tests

- **Choice:** Edit `examples/supervisor/shell/tugboat.sh` and `core/test/tugboat.test.ts`. No engine lock.ts change. No new ship command. Refresh of installed Tugboat remains the existing Option 1 pack parity path.
- **Why:** The flake is in the host composer detach path. Class law is concurrent admission; the shared surface is this one detach function used by Buzz and TUI.

## Risks / Trade-offs

- **[Risk]** A stricter gate timeouts and fails a legitimate second detach while the first is still starting.  
  **Mitigation:** Winner holds until probe sees the new ship (already the R2 wait loop). Loser re-probes and reports already-running with exit 0. Fail closed only if the gate cannot be acquired and probe is still not live.

- **[Risk]** Stale gate from a killed detach blocks later Ship.  
  **Mitigation:** Reclaim only a dead holder (or an aged empty artifact), never an in-progress empty pid. Same class as stale ship-lock reclaim.

- **[Risk]** Host-global `/proc` probe still collides with leftover test stubs.  
  **Mitigation:** Keep unique `9.99.<pid>.<time>` versions and `finally` reap by cmdline needle. Do not reuse `v1.39.x` in the fixture.

- **[Risk]** `flock` / lockfile semantics differ on non-Linux.  
  **Mitigation:** Agent-box / Actions are Linux. Document Linux as the supported host, matching #1062 cmdline probe.

- **[Risk]** Scope creep into release-finish retry.  
  **Mitigation:** Sibling issue. This change only makes the detach test deterministic so a green check is trustworthy.

## Migration Plan

1. Land OpenSpec + Tugboat admission fix + concurrent fixture hardening in one PR for #1111.
2. After merge/promote: refresh installed `tugboat` from `examples/supervisor/shell/tugboat.sh` (existing doctor parity).
3. Rollback: reinstall previous Tugboat. No GitHub schema change.

## Open Questions

- None that block the specs. Implementation may choose `flock` vs a repaired mkdir-gate as long as acquire stays exclusive through identity publish.
