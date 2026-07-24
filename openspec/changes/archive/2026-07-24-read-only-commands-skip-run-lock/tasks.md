# Tasks

## Acceptance criteria

- [ ] `pipeline logs` (list form and `<run-id> --events --follow` form) creates and holds no
      `/tmp/pipeline-*.lock` run-liveness reservation; a long-lived follower leaves nothing
      the installer's live-run scan classifies as a live blocking lock.
- [ ] `install.mjs update` still refuses (exit non-zero, copies no file) while a genuine
      advance/queue run holds a live `pipeline-*.lock`; the update lock, `--force` override,
      and refusal messaging are unchanged (#450 semantics intact).
- [ ] The read-only-command classifier is pure and unit-tested: `logs` / `status` /
      `summary` classify read-only; `advance` / `loop` / `queue` / `improve` (and any
      command not on the allowlist) classify run-mutating — no real I/O.
- [ ] Regression test bites: a logs-shaped read-only invocation produces no blocking lock
      and the update proceeds; an advance-run reservation lock of a live PID still blocks.
      The test fails against the pre-fix launcher that reserved for every command.
- [ ] Stale-lock housekeeping: a `/tmp/pipeline-*.lock` with a provably-dead (`ESRCH`) or
      unparseable PID is unlinked by the installer's scan and by `pipeline doctor`; a live or
      unsignalable-but-present lock is never removed.
- [ ] `pipeline doctor` surfaces a non-blocking `warn` when many stale locks have
      accumulated, and its sweep/warn is covered through the injectable deps seam.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Implementation

1. **Classifier.** In `hosts/_shared/entry.template.mjs`, add a pure
   `isReadOnlyCommand(argv0)` returning true for the read-only allowlist
   (`logs`, `status`, `summary`). Everything else is run-mutating (fail-safe default).
2. **Scope the reservation.** Gate the `reserveRunSlot()` call on
   `!isReadOnlyCommand(rawArgs[0])`. For read-only commands, skip the held reservation
   entirely; optionally keep a non-held `updateInProgress()` pre-spawn courtesy check but do
   not create or hold `pipeline-starting-<pid>.lock`. Leave `releaseRunSlot()` guarded so it
   is a no-op when nothing was reserved.
3. **Installer stale sweep.** In `scripts/install.mjs`, within the existing
   `/tmp/pipeline-*.lock` scan, unlink any lock whose recorded PID is provably dead
   (`ESRCH`) or unparseable, using the same liveness semantics; never touch a live or
   `EPERM` lock. Keep the sweep a pure side effect of the scan — refusal logic unchanged.
4. **Doctor sweep + warn.** In `core/scripts/stages/doctor.ts`, add a maintenance sweep of
   provably-dead pipeline locks and a non-blocking `warn` check when stale-lock count
   exceeds a threshold, wired through the injectable deps seam.
5. **Tests.** Add: pure classifier test; launcher regression (logs-shaped invocation leaves
   no blocking lock, advance-run lock still blocks — prove it bites); installer stale-sweep
   test; doctor sweep/warn test.
6. **Regenerate the mirror.** `node scripts/build.mjs`; commit the regenerated `plugin/`.
7. **Gate.** `npm run ci` from the repo root until green.
