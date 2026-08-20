## Why

`Ship milestone v1.39.5` bound factory-gate pack loop `loop-c6abf57f55524c81`
at 18:56Z. Tugboat FRG wait copies the CI wait defaults
(`FRG_WAIT_ATTEMPTS=30` × `FRG_WAIT_SLEEP_S=40` = 20 minutes). At 19:16Z the
composer wrote `frg-pack → failed` with `FRG pack still in_progress within
wait budget` and exited. Loop pid `3986527` was still alive. #1143 reached
`ready-to-deploy` at 19:21Z. #1144 was still implementing. The pack reached
`loop_run_complete` at 19:43Z (~47 minutes). Failed wait is terminal for
Tugboat (`state.json` failed, pid dead). A human had to re-detach. That is
not unattended ship. A factory-gate pack is a full two-item advance loop, not
a CI poll.

## What Changes

- **Wait-until-terminal while the bound pack loop is live.** A ship-path FRG
  pack composer (Tugboat, the playbook launcher that execs Tugboat, and
  in-engine `pipeline ship`) SHALL keep re-invoking the same
  `factory-release prepare` request while prepare status is `in_progress`
  and the bound loop is live (`lock.json` pid alive **or** ledger not
  terminal). A wait-budget expiry SHALL NOT fail the ship in that case.
- **Heartbeat, not a short fail cap.** The composer SHALL keep
  `state.json` at `frg-pack` / `running` (or the in-engine ship equivalent)
  and SHALL emit a wait heartbeat on each tick. Buzz SHALL NOT see
  `frg-pack → failed` for in-progress wait expiry while the bound loop is
  live.
- **Default wait outlives a 2-item factory-gate pack.** Default FRG pack
  wait SHALL be wait-until-terminal with a heartbeat, not the 20-minute CI
  copy. A numeric attempt cap MAY remain only for the case where the bound
  loop is **not** live. The CI wait (`RELEASE_WAIT_*`) stays a CI poll.
- **Re-detach is not the resume path.** Finishing an in-progress pack SHALL
  not require a human to re-detach Tugboat.
- **Class law, not a 1.39.5 mole.** The next 2-item (or longer) factory-gate
  pack that exceeds 20 minutes SHALL not fail the ship for wait expiry while
  the bound loop is live.

**BREAKING** for any host or test that treats FRG wait-budget expiry while
prepare stays `in_progress` as pack-fail even when the bound loop is live.

Non-goals: raising the implementer 2400s cap; `--skip-frg` as the ship
path; killing the pack loop when a composer poll cap hits; fixing the
unsigned `pass: false` classify hole seen on a later re-detach.

## Acceptance criteria

- [ ] While prepare status is `in_progress` and the bound pack loop is live
      (`lock.json` pid alive or ledger not terminal), Tugboat keeps
      re-invoking the same `factory-release prepare` request and does not
      fail the ship on wait-budget expiry.
- [ ] Default FRG pack wait is wait-until-terminal with a heartbeat, or a
      default long enough for a 2-item factory-gate pack (hours, not 20
      minutes). It does not copy the CI 30×40s fail cap as the live-loop
      stop.
- [ ] `state.json` stays `phase: "frg-pack"` and `status: "running"` while
      the bound loop is live. Buzz does not get `frg-pack → failed` for
      in-progress wait expiry.
- [ ] A tugboat test fails if `in_progress` plus a live bound loop is
      classified as terminal fail after N short sleeps. The test injects
      fixtures and does not start a live pack.
- [ ] In-engine `pipeline ship` applies the same live-loop wait law. A
      20-minute FRG tick cap plus "retry the same ship command to resume"
      is not pack-fail while the bound loop is live.
- [ ] Re-detach is not required to finish an in-progress pack. The same
      composer process keeps ticking prepare until pack-done or a real
      pack-fail.
- [ ] Real pack-fail stays fail-closed: failed or missing FRG, `latest.json`
      `pass: false` after a terminal score, attestor child failure, or
      wait-budget expiry **only** when the bound loop is not live. The
      composer does not kill the pack loop.
- [ ] `--skip-frg` remains an operator escape with a logged reason. It is
      not the default ship path.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat, playbook, FRG, and ship-coordinator law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Pack-fail SHALL NOT include wait-budget exhaustion
  while prepare status is `in_progress` and the bound pack loop is live.
  Tugboat SHALL keep re-invoking prepare, keep `state.json` at
  `frg-pack` / `running`, and heartbeat until pack-done or a real
  pack-fail. Default FRG wait SHALL not copy the CI 20-minute fail cap as
  the live-loop stop.
- `supervisor-ship-playbook`: The playbook launcher SHALL inherit the same
  live-loop wait law through Tugboat. It SHALL NOT keep a second pack wait
  that fails the ship at the CI poll cap while the bound loop is live.
- `factory-reliability-gate`: Ship-path FRG pack composers SHALL wait until
  the bound pack loop is terminal (or a real pack-fail). Wait-budget
  expiry while the bound loop is live SHALL NOT be pack-fail. The next
  identical 20-minute live-loop wait SHALL not need a new mole issue.
- `ship-coordinator`: In-engine `pipeline ship` FRG pack wait SHALL obey
  the same live-loop wait-until-terminal law. A short tick cap plus
  "re-invoke to resume" SHALL NOT fail the ship while the bound loop is
  live.

## Impact

- **Composers:** `examples/supervisor/shell/tugboat.sh` FRG wait loop and
  `write_state` heartbeat; shared
  `examples/supervisor/shell/frg-pack-helpers.sh` if liveness or wait
  classification is shared. Playbook remains a launcher to Tugboat.
- **Engine:** `core/scripts/stages/ship-adapter.ts` FRG wait (`FRG_WAIT_*`
  120×10s today). Do not raise the implementer 2400s cap. Do not kill the
  pack loop. Do not add `--skip-frg` as the ship path.
- **Tests:** `core/test/tugboat.test.ts` and `core/test/ship-adapter.test.ts`
  (or sibling). Tests inject I/O / inspect source or fixtures. They start
  no live pack, network, git, or subprocess ship.
- **Docs:** `docs/runbooks/ship-milestone.md` FRG wait paragraph if it still
  treats wait-budget exhaustion as pack-fail while the pack is in progress.
- **Depends on:** living #1037 prepare protocol (`in_progress` + bound
  `loop_run_id`) and #1133 pack isolation (uncredentialed prepare +
  out-of-process attestor).
- **Does not:** authorize merge/tag/promote/install in the pack phase;
  invent `pass: true`; add a grant factory or second pack runner; reverse
  papercut backlog policy (#538); fix the unsigned `pass: false` classify
  hole from the later re-detach.
