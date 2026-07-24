# Design

## Context

Two coupled mechanisms, both introduced by #450:

1. `hosts/_shared/entry.template.mjs` (`reserveRunSlot()`) writes
   `/tmp/pipeline-starting-<pid>.lock` before `spawnSync` loads the engine, and holds it
   for the full lifetime of the subprocess. Purpose: an installer that begins any time
   during a run observes the reservation and refuses to swap files underneath a live
   engine.
2. `scripts/install.mjs` (`findLiveRunLocks()`) scans `/tmp/pipeline-*.lock`, treats a
   signalable PID as live, `ESRCH` as stale, `EPERM` conservatively as live, and refuses
   the update while any live lock is present.

The launcher reserves for **every** command. `pipeline logs --follow` is read-only and
long-lived, so it parks a live reservation for hours and the installer refuses — even
though a file swap cannot affect a process that is only tailing `terminal.log` /
`events.jsonl`.

## Goal

A read-only command must not block an update, while a genuine advance/queue run still must.
The distinguishing fact available at the launcher is the **command name** in `process.argv`
— the launcher already inspects `rawArgs` for `--version` / `doctor`. Liveness of the PID is
not the discriminator (both a follower and an advance run have live PIDs); the *command* is.

## Decision: scope the reservation to run-mutating commands (option A — no lock)

The launcher classifies the subcommand. For a read-only command it does **not** call
`reserveRunSlot()` at all, so no `pipeline-starting-<pid>.lock` is ever written and the
installer's scan has nothing to see. For a run-mutating command the existing #450 dance is
unchanged.

Read-only set (initial, explicit allowlist): `logs`, `status`, `summary`. `--version` /
`-V` already short-circuit before the reservation; `doctor` is deterministic and read-only
but keeps its existing dedicated handling. Everything not on the read-only allowlist is
treated as run-mutating and reserves — this fail-safe default means a newly added command
gets the protective reservation unless it is deliberately classified read-only.

### Why not option B (a distinguishable read-only lock the installer ignores)

The issue offers either "creates no run-liveness lock" or "creates one the installer
classifies as read-only and ignores." Option B adds a second lock name and new
classification logic in the installer scan, and a new failure mode (mis-tagging a mutating
run's lock as read-only would silently defeat #450). Option A removes surface instead of
adding it, keeps the installer scan a single uniform rule, and cannot mis-classify a
mutating run because mutating runs still use the one existing reservation path. The
regression test expresses the same guarantee: a logs-shaped invocation produces no blocking
lock; an advance-run lock still blocks.

### Load-time coherence for read-only commands

Skipping the held reservation means a read-only command loses the reservation's protection
against loading a half-swapped engine tree mid-copy. This is acceptable and explicitly
sanctioned by the issue's acceptance criteria: the worst case is a read-only command failing
to load or tailing under a freshly-swapped engine — transient, recoverable, non-destructive,
unlike a mutating run corrupting worktree/git state. The launcher MAY still perform the
cheap, non-held `updateInProgress()` pre-spawn check and decline to start into an update
that is already in progress; it does not hold a lock across its lifetime. Only the "does not
hold a run-liveness lock" guarantee is normative.

## Decision: sweep provably-dead locks opportunistically

The 58 accumulated locks are dead-PID files nothing cleans up. Two sweep sites, both
already computing PID liveness:

- **Installer scan** — while `findLiveRunLocks()` walks `/tmp/pipeline-*.lock`, unlink any
  lock whose recorded PID is provably dead (`ESRCH`) or whose contents hold no parseable
  PID. Never unlink a live lock or an `EPERM` (present-but-unsignalable) lock — those stay
  blocking exactly as today. The sweep is a side effect of a scan the installer already
  runs; it does not change refusal semantics.
- **`pipeline doctor`** — add a maintenance action that sweeps the same provably-dead locks
  (so housekeeping happens even when no update runs, which is the failure mode that let 58
  accumulate) and a non-blocking `warn` check that surfaces when many stale locks remain.
  Doctor must stay deterministic and LM-free; a filesystem sweep is fine within that.

Conservative-liveness parity is critical: the sweep uses the exact same
signalable/`ESRCH`/`EPERM` semantics as `PipelineLock` and the installer scan, so it can
never remove a lock that would otherwise (correctly) block an update.

## Testing

- Pure classifier unit test: `isReadOnlyCommand("logs") === true`,
  `isReadOnlyCommand("advance"|"loop"|"queue"|"improve") === false`, no I/O.
- Launcher/regression: a logs-shaped invocation leaves no `pipeline-starting-*.lock`, so the
  installer proceeds; an advance-run reservation lock of a live PID still blocks (asserts no
  file copied). The test bites against the pre-fix launcher that reserves for every command.
- Installer stale-sweep: a dead-PID lock is unlinked by the scan; a live lock and an
  unsignalable lock are retained and still block.
- Doctor: dead-PID locks are swept; the accumulation `warn` fires past a threshold; a live
  lock is never swept. Driven through doctor's injectable deps seam — no real signals.

## Non-goals

- No cross-host lock coordination — `/tmp` locks remain host-local per the documented
  concurrency scope (#459). This change only refines which *local* invocations create a
  local lock.
- No change to the installer's live-run refusal, update lock, `--force`, or the never-merge
  boundary.
