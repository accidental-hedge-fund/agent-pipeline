## Context

See proposal.md — Why. Option 1 detach lives in `examples/supervisor/shell/tugboat.sh`. #1062 made the live-ship probe the only refuse gate. A later R2 pass added `try_acquire_detach_gate` (`mkdir` of `ship-vX.Y.Z/detach.gate`) to serialize probe-and-spawn. `core/test/tugboat.test.ts` already has `detach race (#1062 R2): concurrent Ship detaches exactly once`. That test spawned two `--detach` processes on CI run `32075787450` and both printed `detached tugboat ship`.

Confirmed hole in the current gate (read of `try_acquire_detach_gate` on this branch): after `mkdir` succeeds, the holder writes `detach.gate/pid` in a second step. A waiter that sees an empty pid treats the gate as stale, `rm -rf`s it, and `mkdir`s again. Both processes then believe they hold the gate. Releasing (or printing detach) before `live_ship_probe` can see the child preserves the same double-detach if a second acquirer slips in.

Current constraints:

- Live-ship refuse must stay probe-based (train `--merge` or owning tugboat). Gate or lock-file presence is not a live ship.
- Host-local PID / directory / flock locks remain single-host. This change does not add a cross-host mutex.
- The concurrent test must stay. Do not skip it. Do not mark it flaky.
- Surgical: close concurrent admission. Do not rewrite the ship composer.

## Goals / Non-Goals

**Goals:**

- Make overlapping `--detach` for one milestone admit exactly one ship on GitHub Actions, not only on a quiet local run.
- Keep refuse meaning = live-ship probe. Serialize the check; do not replace the probe with “lock file exists.”
- Keep the two-spawn fixture and its bite: two `detached tugboat ship` lines fail the test.
- Use a product serialization that cannot lose to scheduler interleaving. The test may add a start barrier so both processes are released together; that barrier is not the pass condition.

**Non-Goals:**

- Cross-host ship lock.
- Changing the live-ship definition, REPO_DIR pin, or status rewrite.
- Sibling recover: release-finish re-run of a failed check.
- Deleting, skipping, or quarantining the concurrent test.
- A second refuse heuristic in Hermes / chat.
- Engine `core/scripts/lock.ts` / issue-run lock changes.

## Decisions

### 1. Fix admission in Tugboat, not by weakening the test

- **Choice:** Close the race in `detach_self` / the per-milestone admission lock so two overlapping `--detach` processes cannot both pass not-live and both spawn. Keep the existing two-spawn fixture as the regression.
- **Why:** The CI failure is a real double detach, not a false-positive assertion. A sleep-only test pass would hide the product hole on a faster or slower runner.
- **Alternative:** Mark the test flaky / skip it — **rejected** (issue forbids this).
- **Alternative:** Delete the test — **rejected**.
- **Alternative:** Only add a sleep in the test and leave the gate as-is — **rejected** as the primary fix.

### 2. Admission protocol (locked)

Replace the racy `mkdir` + later `pid` write. Use a regular lock file and Linux `flock(1)` exclusive lock.

Protocol for one `(repo-token, milestone)`:

1. **Atomic acquire.** Open the lock file and take `flock` exclusive (`flock -n` to try, `flock -w <timeout>` to wait). The kernel grants at most one holder. Do not treat “file exists” as held.
2. **Loser waits, then re-probes.** A process that does not get the lock immediately SHALL block on `flock -w` until the winner releases (or the timeout). After it acquires, it SHALL call `live_ship_probe`. It SHALL NOT treat lock presence, flock wait, or a leftover lock file as “already running.”
3. **Winner holds until the child is discoverable.** After `nohup` of the detached child, the winner SHALL keep the flock until `live_ship_probe` prints a pid for that milestone (or the documented wait bound expires). It SHALL NOT release immediately after backgrounding. It SHALL emit `detached tugboat ship` only after that probe succeeds.
4. **Loser path after re-probe.** If the probe is live: print the existing already-running / not-detaching line, emit status, exit 0, release. If the probe is not live after a successful acquire: this process is the new winner and may spawn. If the wait times out and the probe is still not live: fail closed (non-zero). Do not spawn a second ship.
5. **Identity in the file.** After acquire, write owner identity (`pid` plus starttime when readable, same class as `formatProcessIdentityMarker` in `core/scripts/lock.ts`) into the lock file for diagnostics and stale reclaim. Write after flock; the flock, not the write, is the mutex.
6. **Cleanup.** `trap` on `EXIT`, `INT`, and `TERM` (and `RETURN` when the helper is function-scoped, matching `ship_one` in `tugboat.sh`) closes the fd / releases flock and, when this process is the recorded owner, may unlink the file. Process death also drops flock, so a crashed winner cannot hold the mutex forever.
7. **Stale recovery.** A leftover lock file with no live flock holder is not a hold. A waiter that sees a recorded owner pid that is dead (or starttime mismatch) may unlink and retry acquire. Never reclaim solely because the identity file is briefly empty while a live flock holder exists. Never refuse detach solely because the file exists.

**Rejected:** empty-pid-as-immediately-stale + `rm -rf` of a just-created `detach.gate` (this is the #1109 hole). **Rejected:** treating the admission file as a live ship. **Rejected:** writing `playbook.pid` from the detach parent before the child wins the ship lock (#1062). **Rejected:** silent fallback to the current mkdir-gate if `flock` is missing — fail closed and name the missing primitive. Linux is the supported host (same as the `/proc` cmdline probe).

### 3. Lock scope and path

- **Scope:** host-local only. No cross-host claim.
- **Key:** pinned `REPO_DIR` (realpath, already computed by `pin_repo_dir`) plus milestone `safe_of(X.Y.Z)`.
- **Path:** under `$STATE_ROOT` (env `PIPELINE_SUPERVISOR_STATE`, default `$HOME/.local/state/pipeline-supervisor`), not under `pwd`.
- **Concrete form:** `$STATE_ROOT/admission/<repo-token>/v<safe-milestone>.lock`
  - `repo-token` is a stable hash of the pinned `REPO_DIR` realpath (hex; no raw path characters). Two working directories of the same realpath share one lock. Two different repos that share `STATE_ROOT` and the same SemVer do not collide.
  - Milestone uses existing `safe_of` (lowercase, dots kept).
- Do not key the admission lock on issue number or `playbook.pid`. Do not reuse `/tmp/pipeline-{domain}-{N}.lock`.

### 4. Concurrent fixture stays two real spawns; start is a barrier

- **Choice:** Keep `Promise.all` of two `bash tugboat --detach` processes, unique `9.99.<pid>.<time>` milestone, fake long-lived `PIPELINE`, isolated `PIPELINE_SUPERVISOR_STATE` and `REPO_DIR`. Both exit 0 on the success path. Reap stubs in `finally`.
- **Start barrier (test-only wrapper, not a product hook):** each child is a stub that writes a ready file and blocks until the test creates a go file (or FIFO), then `exec`s real `tugboat --detach`. The test waits until both ready files exist, then releases both, then waits for both process exits. Combined stdout+stderr is the assertion input.
- **Pass condition:** exactly one `detached tugboat ship` line and exactly one already-running / not-detaching line. Fail if both emit `detached tugboat ship`. Do not use `sleep` as the pass condition. Product `flock` is the admission serializer.
- **Alternative:** Replace the process fixture with static source assertions only — **rejected** as the sole check. Keep a source assertion that the admission helpers exist.

### 5. Extra regressions stay next to the existing #1062 cases

Keep the existing sequential / negative #1062 tests (bare `playbook.pid`, issue-run lock, stale `state.json`, live train `--merge` / owning tugboat). Add separate tests for:

- Loser waits on flock, then refuses after the winner is live (the concurrent fixture’s already-running line is this case).
- Leftover admission lock file (dead or absent owner, no live flock) does not block a sequential `--detach`.
- Failed spawn or expired wait-for-live releases admission so a later `--detach` can proceed.

### 6. Scope stays Tugboat + tugboat tests + this OpenSpec change

- **Choice:** Edit `examples/supervisor/shell/tugboat.sh` and `core/test/tugboat.test.ts`. Update this change’s design/tasks/spec only as needed. No engine `lock.ts` change. No new ship command. Refresh of installed Tugboat remains the existing Option 1 pack parity path.
- **Docs:** `docs/runbooks/ship-milestone.md` only if the already-running line or the documented gate/lock artifact name changes (it will: `detach.gate` → admission `.lock`). One sentence: concurrent Ship for the same repo+milestone serializes on that lock; refuse is still the live-ship probe.

## Risks / Trade-offs

- **[Risk]** A lock that serializes only the first probe and then releases before live-process evidence exists still yields two detach lines.  
  **Mitigation:** Hold flock until `live_ship_probe` succeeds. Print `detached tugboat ship` only after that. Loser acquires only after release, then re-probes.

- **[Risk]** Wait bound expires before a slow child execs; winner fails closed and a later detach retries.  
  **Mitigation:** Prefer that fail-closed over a second detach. Bound should cover `nohup` + child exec on Actions (document the bound next to the wait loop).

- **[Risk]** Stale lock file from a killed detach blocks later Ship.  
  **Mitigation:** Flock is released on process death. Leftover file is not a hold. Dead-owner unlink is allowed.

- **[Risk]** Host-global `/proc` probe still collides with leftover test stubs.  
  **Mitigation:** Keep unique `9.99.<pid>.<time>` versions and `finally` reap by cmdline needle. Do not reuse `v1.39.x` in the fixture.

- **[Risk]** `flock` missing on a non-Linux host.  
  **Mitigation:** Fail closed. Agent-box / Actions are Linux. Same support floor as the `/proc` probe.

- **[Risk]** Scope creep into release-finish retry.  
  **Mitigation:** Sibling issue. This change only makes the detach test deterministic so a green check is trustworthy.

## Migration Plan

1. Land OpenSpec + Tugboat admission fix + concurrent fixture hardening in one PR for #1111.
2. After merge/promote: refresh installed `tugboat` from `examples/supervisor/shell/tugboat.sh` (existing doctor parity).
3. Rollback: reinstall previous Tugboat. No GitHub schema change.

## Open Questions

- None. `flock` is the locked primitive (Decision 2). Path and hold-until-live are locked (Decisions 2–3).
