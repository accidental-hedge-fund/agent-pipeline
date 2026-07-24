## Why

The shared launcher (`hosts/_shared/entry.template.mjs`) reserves a
`/tmp/pipeline-starting-<pid>.lock` run-liveness slot before it spawns the engine and
holds it for the **entire lifetime** of the subprocess (#450 round 2 — correct for a
genuine advance/queue run, which must not have its files swapped underneath it). But the
launcher does this for **every** command, including read-only ones. A
`pipeline logs <run-id> --events --follow` follower is read-only — it just tails a file —
yet it holds a `pipeline-starting-<pid>.lock` for its whole run, and followers routinely
live for hours. The installer's live-run scan matches `/tmp/pipeline-*.lock`, sees a live
PID, and refuses the update.

The result observed on 2026-07-23/24: `node scripts/install.mjs update` was blocked twice
by a plain log follower (pids 1828638 at 6h+, 2691118 at 4h+), stalling both the v1.25.0
and v1.26.0 refreshes and leaving the installed engine pinned at 1.24.0. An install swap
cannot corrupt a read-only follower, so this block is pure false-positive. Separately,
58 `/tmp/pipeline-*.lock` files had accumulated on one host — stale dead-PID locks that
nothing sweeps.

## What Changes

- **Read-only commands do not reserve a run-liveness lock.** The launcher SHALL classify
  read-only, non-run-mutating commands (`logs`, and the other read-only report commands
  `status` / `summary`) and SHALL NOT create or hold the `pipeline-starting-<pid>.lock`
  reservation for them. Only run-mutating commands (advance/loop/queue/improve and the
  other engine-mutating subcommands) reserve the slot. A read-only command therefore never
  appears in the installer's live-run scan and never blocks an update. It MAY still decline
  to start if an update is already in progress, but it does not hold a lock across its
  lifetime.
- **The #450 deferral for genuine runs is unchanged.** A real advance/queue run still
  reserves the slot before loading the engine, still re-checks the update lock, and the
  installer still refuses to swap files while any such live run lock is present. The
  installer's live-run scan, the update lock / TOCTOU critical section, `--force`, and the
  refusal messaging are untouched.
- **Stale dead-PID locks are swept opportunistically.** The installer, which already scans
  `/tmp/pipeline-*.lock` and computes PID liveness, SHALL unlink any lock whose recorded PID
  is provably dead (`ESRCH`) during that scan — never a live or unsignalable-but-present
  one. `pipeline doctor` SHALL additionally sweep the same provably-dead locks as a
  maintenance action and surface a non-blocking `warn` when many stale locks have
  accumulated, so housekeeping does not depend on an update ever running.

## Capabilities

### Modified Capabilities

- `update-live-run-deferral`: the launcher's pre-spawn reservation is scoped to
  run-mutating commands; read-only commands do not reserve or hold a run-liveness lock, so
  they never block an update. The installer additionally sweeps provably-dead pipeline locks
  during its live-run scan.

### New Capabilities

<!-- The behavior is added to two existing capabilities rather than as a standalone one:
     the read-only-command guarantee for `logs` lives in log-follow-command, and the
     stale-lock maintenance sweep lives in doctor-preflight. -->

## Acceptance criteria

- [ ] `pipeline logs` (list form and `<run-id> --events --follow` form) does not create or
      hold any `/tmp/pipeline-*.lock` run-liveness reservation for the duration of the
      command; a long-lived follower leaves no lock that the installer's live-run scan
      classifies as live.
- [ ] `install.mjs update` still refuses (exit non-zero, copies no file) while a genuine
      advance/queue run holds a live `pipeline-*.lock` — #450 semantics unchanged, including
      the update lock, `--force` override, and refusal messaging.
- [ ] Regression test: a fake lock of the logs-follower launcher shape does **not** block
      the update path, while an advance-run reservation lock of a live PID still does. The
      test bites — it fails against the pre-fix launcher that reserves for every command.
- [ ] The read-only-command classification is a pure, unit-tested function: given a command
      name it decides reserve / do-not-reserve with no real filesystem, process-signal, or
      subprocess call.
- [ ] Stale-lock housekeeping: a `/tmp/pipeline-*.lock` whose recorded PID is provably dead
      is unlinked opportunistically by the installer's scan and by `pipeline doctor`, and a
      live or unsignalable-but-present lock is never removed.
- [ ] `npm run ci` is green: core tests, `build.mjs --check` (the regenerated `plugin/`
      mirror is committed and in sync), install smoke, and `openspec validate --all`.

## Impact

- `hosts/_shared/entry.template.mjs` — classify the command; skip the
  `reserveRunSlot()` reservation for read-only commands. Regenerated into the `plugin/`
  mirror by `node scripts/build.mjs`.
- `scripts/install.mjs` — during the existing live-run scan, unlink locks whose recorded
  PID is provably dead (`ESRCH`); no change to the refusal / update-lock logic.
- `scripts/install.test.mjs` — regression coverage: logs-shaped read-only invocation does
  not block; advance-run lock still does; stale locks are swept.
- `core/scripts/stages/doctor.ts` (+ `doctor.test.ts`) — a maintenance sweep of dead-PID
  pipeline locks and a `warn` on accumulation.
- No change to the installer's live-run refusal semantics, the update lock / TOCTOU
  critical section, `--force`, or the pipeline's never-merge boundary.
