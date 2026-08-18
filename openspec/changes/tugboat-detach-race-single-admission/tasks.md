## 1. Confirm the concurrent admission hole

- [ ] 1.1 Reproduce the #1109 fixture locally: two overlapping `tugboat --detach` for one unique milestone, using the existing `detach race (#1062 R2)` test or the same two-spawn shape.
- [ ] 1.2 Confirm whether `try_acquire_detach_gate` can admit two holders (empty `detach.gate/pid` treated as stale, or any other reclaim that races the winner’s identity publish).

## 2. Serialize probe-and-spawn

- [ ] 2.1 Make per-milestone detach admission exclusive for the whole hold, including identity publish. A waiter MUST NOT reclaim a gate whose holder has not finished publishing.
- [ ] 2.2 Keep refuse meaning on `live_ship_probe`. Gate or lock presence alone MUST NOT count as a live ship.
- [ ] 2.3 After the winner detaches, hold admission until the new ship is visible to the probe (or the documented bound). The loser MUST take the already-running / not-detaching path and MUST NOT print `detached tugboat ship`.
- [ ] 2.4 Preserve sequential #1062 behavior: live train `--merge` / owning tugboat still refuses; bare `playbook.pid` + `kill -0`, issue-run lock, and stale `state.json` still do not refuse.

## 3. Keep and harden the concurrent fixture

- [ ] 3.1 Keep `core/test/tugboat.test.ts` `detach race (#1062 R2): concurrent Ship detaches exactly once`. Do not delete, skip, or mark it flaky.
- [ ] 3.2 Keep the two-spawn shape: both processes start together, both exit 0 on the success path, unique `9.99.*` milestone, isolated state dir, reap stubs in `finally`.
- [ ] 3.3 Assert exactly one `detached tugboat ship` line. Fail if both emit that line.
- [ ] 3.4 Do not use a sleep-only pass condition. If extra wait is needed, wait on the documented lock/gate artifact or on one process’s detach/refuse output.
- [ ] 3.5 Prove the assertion still bites: the same two-spawn fixture fails when both outputs contain `detached tugboat ship`.

## 4. Validate and CI

- [ ] 4.1 Run `openspec validate tugboat-detach-race-single-admission` and fix structural errors.
- [ ] 4.2 Run the tugboat tests (`cd core && node --test --experimental-strip-types test/tugboat.test.ts`).
- [ ] 4.3 If any file under `core/` changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [ ] 4.4 Run `npm run ci` from the repo root and leave it green.
