## 1. Live-ship probe (Tugboat)

- [x] 1.1 Replace detach “already running” decision with a live-ship probe: live only when a process cmdline is train with `--merge` for the requested milestone, or the owning tugboat for that milestone.
- [x] 1.2 Ensure bare `playbook.pid` / lock pid + `kill -0` alone does not refuse detach when the probe is not live.
- [x] 1.3 Ensure a held per-issue `pipeline N` / issue-run lock alone does not refuse detach.
- [x] 1.4 On live probe: report status + notify already-running; do not spawn a second detach (Buzz and TUI share this path; no paste detector).
- [x] 1.5 On not-live probe: detach exactly once for the ship request.

## 2. Status liveness

- [x] 2.1 Teach `--status` not to claim `running` from dead recorded pid or stale `state.json` alone; use the same live-ship probe class for the running claim.
- [x] 2.2 Keep `--status` read-only (no train/release/promote side effects).

## 3. REPO_DIR pin and factory-control refuse

- [x] 3.1 Resolve/canonicalize `REPO_DIR` once at tugboat start; refuse paths matching `*factory-control*` with a clear error; do not retarget from session/model text after pin.
- [x] 3.2 Fix `examples/supervisor/hermes/env.example` so default `REPO_DIR` is not `*factory-control*`.
- [x] 3.3 Update Hermes skill / deployment runbook notes only as needed so operators do not treat issue locks or dead pids as live ships and do not point ship at factory-control.

## 4. Regression tests

- [x] 4.1 Extend `core/test/tugboat.test.ts` (and pure helper fixtures if probe logic is extracted) for: live train cmdline → refuse second detach; bare pid only → not live; issue lock alone → still detach; dead pid status → not running.
- [x] 4.2 Assert `env.example` does not default `REPO_DIR` to `*factory-control*`; assert tugboat source refuses that plane.
- [x] 4.3 Prove at least one regression bites without the fix (probe or refuse).

## 5. Validate and CI

- [x] 5.1 Run `openspec validate ship-milestone-live-detach` and fix structural issues.
- [x] 5.2 Run targeted core tests for tugboat / ship path.
- [x] 5.3 If any `core/` files changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 5.4 Run `npm run ci` from repo root and leave green.
