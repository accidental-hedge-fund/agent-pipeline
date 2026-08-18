## Why

CI on release PR **#1109** (`5606ec5b`, run `32075787450`) failed only `detach race (#1062 R2): concurrent Ship detaches exactly once`. Two concurrent `tugboat --detach` processes for the same milestone both printed `detached tugboat ship`. #1062 already defined live-ship as process evidence and required a second Ship to refuse; the remaining hole is concurrent admission. Two processes can both observe not-live and both detach. That flake killed `Ship milestone v1.39.2` at release-finish.

## What Changes

- Close the concurrent-admission hole for Option 1 Tugboat `--detach`: two overlapping `--detach` invocations for the same milestone MUST admit exactly one live ship and send the other down the already-running / not-detaching path. They MUST NOT both emit `detached tugboat ship`.
- Keep the #1062 live-ship probe as the meaning of “already running.” The admission lock serializes probe-and-spawn. Gate presence alone is not a live ship.
- Keep the existing concurrent fixture in `core/test/tugboat.test.ts`. Make the outcome deterministic on GitHub Actions (no sleep-only race). Do not delete the test. Do not mark it flaky or skip it.
- Keep the regression bite: the same two-spawn fixture MUST fail if both processes emit `detached tugboat ship`.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `tugboat-thin-ship`: Concurrent `--detach` for one milestone admits exactly one ship. The concurrent regression stays enabled and fails closed when two detaches print.

## Acceptance criteria

- [ ] Two overlapping `tugboat --detach` processes for the same milestone produce exactly one `detached tugboat ship` line and exactly one live ship for that milestone.
- [ ] The loser of that race takes the already-running / not-detaching path (or an equivalent documented refuse that does not spawn a second ship). It does not print `detached tugboat ship`.
- [ ] Both processes still exit 0 in the success fixture (one detach + one refuse), matching the CI case that failed on #1109.
- [ ] A second sequential `--detach` after a live ship exists still uses the #1062 live-ship probe (train `--merge` or owning tugboat). Bare `playbook.pid` + `kill -0`, a per-issue pipeline lock, and stale `state.json` still do not refuse detach.
- [ ] `core/test/tugboat.test.ts` keeps a concurrent two-spawn fixture. The test is not deleted, skipped, or marked flaky.
- [ ] That fixture fails if both processes emit `detached tugboat ship`.
- [ ] The concurrent fixture does not use a sleep-only race as the pass condition. Admission is serialized in the lock/probe, or the test waits on a documented lock/gate artifact before it asserts.
- [ ] `openspec validate tugboat-detach-race-single-admission` and `npm run ci` are green when implementation lands.

## Impact

- **Primary surface:** `examples/supervisor/shell/tugboat.sh` (`detach_self`, per-milestone `detach.gate` / equivalent admission lock).
- **Tests:** `core/test/tugboat.test.ts` concurrent detach fixture (`detach race (#1062 R2)`). Keep the same two-spawn shape that failed on Actions.
- **Docs:** ship-milestone / Hermes notes only if the already-running line or gate artifact name changes.
- **Install:** Tugboat is an Option 1 pack file. After the fix, hosts must refresh `~/.local/bin/tugboat` from the repo example (existing content-parity doctor).
- **Out of scope:** release-finish re-run of a failed check (sibling recover issue on #1109). Cross-host ship mutex. Paste detector. Changing the live-ship definition. Deleting or skipping the concurrent test. Advance/loop merge. A second ship brain.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** concurrent admission to a host-local exclusive detach MUST serialize probe-and-spawn. A live-process probe is not an admission mutex. Two processes that both observe not-live MUST NOT both spawn. **Site:** Tugboat `--detach` for one milestone, and the existing concurrent test. |
| Shared surface? | Per-milestone detach admission in Tugboat (`detach_self` + gate/lock). Buzz and TUI already share this path. Do not add a second refuse heuristic in chat. |
| Next identical fault? | The same two-spawn fixture fails if both emit `detached tugboat ship`. The next overlapping Ship cannot stack two ships without a red CI test. |
