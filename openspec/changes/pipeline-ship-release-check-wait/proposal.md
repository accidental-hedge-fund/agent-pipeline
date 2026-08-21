## Why

`pipeline ship --milestone` is the product ship path (#1096). Docs and living
`ship-coordinator` already say: `release` → wait until release-PR checks are
green → `release finish`. The engine does not wait. `convergeReleaseFinish`
re-observes train/FRG, then calls `finishRelease` once. Bare `release finish`
takes one `gh pr checks` snapshot and throws on pending or fail. Unattended
in-engine ship without Tugboat fails the same way the v1.34.0 playbook failed:
`observable checks are not green: test (pending)`. v1.39.9 HMAC ship succeeded
only because Tugboat polled PR #1204 until green, then finish. Closed #1110
said later `pipeline ship` must adopt `ship-release-check-wait`. #1096 shipped
without that adoption.

## What Changes

- In-engine `pipeline ship` SHALL apply living `ship-release-check-wait`
  **before** `pipeline release finish`. Classification SHALL be exactly one of
  `green` / `pending` / `rerun` / `fail` from `gh pr checks --json
  name,state,bucket,link`. The waiter SHALL NOT request a `conclusion` field.
- `green` → invoke finish. `pending` → keep waiting inside the coordinator
  (durable resume on same-argv retry is allowed; a one-shot throw on pending
  is not). `rerun` → one bounded `gh run rerun --failed` per head SHA (budget
  SHALL NOT exceed two), then resume wait. `fail` → persist ship failure;
  SHALL NOT call finish.
- The waiter SHALL be shared law, not a Tugboat-only helper. Tugboat MAY keep
  calling the same classifier. It SHALL NOT remain the only implementation.
- Bare `pipeline release finish` stays one-shot fail-closed. This change does
  not turn the leaf CLI into an unbounded poller.
- `docs/runbooks/ship-milestone.md` SHALL match the in-engine wait.

**BREAKING** for any host or test that treats in-engine `pipeline ship` as
done when `convergeReleaseFinish` calls finish on a pending checks snapshot.

## Acceptance criteria

- [ ] In-engine `pipeline ship` classifies a release-PR `gh pr checks --json
      name,state,bucket,link` capture as exactly one of `green` / `pending` /
      `rerun` / `fail` before `release finish`. It does not request a
      `conclusion` field.
- [ ] Classification `green` is the only path that invokes finish for an
      unfinished release PR.
- [ ] Classification `pending` keeps waiting inside the coordinator. A
      one-shot throw on pending does not persist ship failure. Same-argv retry
      may resume the wait.
- [ ] Classification `rerun` requests `gh run rerun --failed` once per head
      SHA (budget does not exceed two), then resumes wait. It does not call
      finish on that poll.
- [ ] Classification `fail` persists ship failure and does not call finish.
- [ ] A unit test fails if `convergeReleaseFinish` (or the seam it calls)
      invokes finish while the waiter would classify `pending`.
- [ ] A second unit test fails if a settled flake-eligible `test` fail does
      not request `gh run rerun --failed` before a second wait.
- [ ] Those tests inject `gh` and clock via `deps`. They make no live
      network, git, or Actions calls.
- [ ] Tugboat is not the only waiter implementation. In-engine ship applies
      the same living `ship-release-check-wait` law.
- [ ] `docs/runbooks/ship-milestone.md` describes the in-engine wait. After
      any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This adopts existing ship-release-check-wait into in-engine ship. -->

### Modified Capabilities

- `ship-coordinator`: In-engine `pipeline ship` SHALL apply living
  `ship-release-check-wait` before `release finish`. `convergeReleaseFinish`
  (or the seam it calls) SHALL NOT invoke finish while the waiter classifies
  `pending` or `rerun`. `fail` SHALL persist ship failure without finish.
- `ship-release-check-wait`: In-engine `pipeline ship` SHALL be a required
  adoption site of the shared classifier and bounded rerun recipe. Tugboat
  MAY keep calling the same classifier. It SHALL NOT remain the only
  implementation.

## Impact

- **Engine:** `core/scripts/stages/ship-adapter.ts` `convergeReleaseFinish`
  (and the waiter seam it calls). Reuse existing `getPrChecks` /
  `extractWorkflowRunId` / `rerunFailedWorkflows` in `core/scripts/gh.ts`.
  Do not change bare `release-finish.ts` into a poller.
- **Coordinator:** `core/scripts/stages/ship.ts` still sequences
  `release_prepare` then `release_finish`. The wait lives in the finish
  converge seam (or a named seam it calls). Status may heartbeat on
  `release_finish` while waiting.
- **Tests:** `core/test/ship-adapter.test.ts` (or a sibling). Inject `gh` /
  clock. No live network.
- **Docs:** `docs/runbooks/ship-milestone.md` wait-checks paragraph.
- **Tugboat / playbook:** keep the existing Python helper. Do not delete
  `tugboat.sh` or `pipeline-ship-playbook`.
- **Depends on:** living `ship-release-check-wait` (#1110) and in-engine
  ship (#1096).
- **Does not:** MessagingPort / ship-auth issuer (#966–#968); KEY_FILE HMAC
  (#1181); stage-watch argv (#1184); `--skip-frg`; human `git tag`; grant
  JSON; merge inside advance/loop; a second recoverer in `train.ts`.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** in-engine `pipeline ship` omits the shared release-PR check waiter and one-shots `release finish` on a pending or fail snapshot. **Site:** v1.39.9 HMAC ship succeeded only because Tugboat polled PR #1204; unattended `pipeline ship` would throw `observable checks are not green: test (pending)`. |
| Shared surface? | Living `ship-release-check-wait` classifier + bounded `gh run rerun --failed` recipe. `ship-coordinator` / `convergeReleaseFinish` adopts it. Tugboat may keep the Python helper. |
| Next identical fault? | The next unattended `pipeline ship` waits until green (or bounded rerun, or terminal fail) before finish. A pending snapshot does not fail the ship. It does not need a new mole issue. |
