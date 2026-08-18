## Why

`Ship milestone v1.39.2` opened release PR **#1109**. The release-finish waiter saw the `test` check in a settled `fail` bucket four times and STOPPED. The fail was a flaky unit test (`detach race (#1062 R2)` on Actions run `32075787450`), not a broken release tree. `release-prepare` had already passed `npm run ci` locally. The waiter never called `gh run rerun --failed` and never waited again. Hermes did not recover. Buzz then led with a leftover `[pipeline] tester-evidence: trusted-surface blocked…` warn from earlier train items, not the check name or run URL.

## What Changes

- Land a **shared ship-release check-wait recipe** (classifier + bounded rerun + structured fail detail). Tugboat and the chain playbook both adopt it. Later in-engine `pipeline ship` (#1096) must adopt the same recipe when it waits on a release PR. This change does not implement #1096.
- On first settled fail of a **flake-eligible** release-PR check (`test` or documented equivalent): request `gh run rerun --failed <id>`, then resume the existing wait loop. Bound the reruns (default 1, max 2).
- STOP only after the rerun budget is spent, or when a settled fail includes a **non-test product** check (build of release files, required non-flake job).
- Failure detail SHALL name: PR, check name, conclusion/bucket, run URL, last failed test title when available. It SHALL NOT lead with an unrelated `tester-evidence` warn.
- Re-Ship / `release finish` after a later green check MUST reuse the existing open release PR for that version (for #1109, reuse it; do not open a second release PR).

**BREAKING (waiter policy):** the living Tugboat/playbook rule “any settled fail is immediately terminal” is replaced for flake-eligible test checks. Non-test product fails stay fail-closed on first sight.

## Capabilities

### New Capabilities

- `ship-release-check-wait`: Shared ship-path law for the release-PR CI waiter. Classifies settled checks as green, pending, rerun-eligible fail, or terminal fail. Applies a bounded `gh run rerun --failed` recipe. Emits structured fail detail. Does not use leftover train `tester-evidence` warns as the lead reason.

### Modified Capabilities

- `tugboat-thin-ship`: The CI wait before `pipeline release finish` SHALL apply the shared recipe. First flake-eligible `test` fail is not STOP. Fail detail prefers the checks capture. Re-Ship for the same version still reuses the open release PR.
- `supervisor-ship-playbook`: The chain playbook’s C0 wait SHALL apply the same shared recipe and fail-detail rule so the alternate composer is not a second mole.

## Acceptance criteria

- [ ] On a fixture `gh pr checks` capture whose only settled fail is check `test`, the waiter requests `gh run rerun --failed` for that run id exactly once (default budget), then resumes the wait loop. It does not mark release-finish failed on that first fail.
- [ ] After that one rerun, a later poll that reports `test` as `pass` proceeds to `pipeline release finish` for the same PR. The phase is not STOP.
- [ ] A second settled `test` fail after the rerun budget is spent marks release-finish failed. The operator-visible detail includes the PR number, check name `test`, fail/bucket conclusion, and the Actions run URL. It does not lead with `[pipeline] tester-evidence:` or `trusted-surface blocked`.
- [ ] A first settled fail of a non-test product check (for example a release-file build job) marks release-finish failed immediately. The waiter does not request `gh run rerun --failed`.
- [ ] A mixed set (flake-eligible `test` fail plus a non-test product fail) is terminal. The waiter does not rerun to paper over the product fail.
- [ ] After a later green check on the same open release PR, a new Ship / `release finish` for that version reuses the existing PR (for the #1109 class: reuse it) and does not open a second release PR.
- [ ] Unit tests inject `gh` / helper fakes (or fixture JSON for the pure helper). They do no real network, git, or Actions calls. A first-fail-then-pass fixture would have caught the #1109 STOP. A budget-exhausted fixture asserts the check URL, not a trusted-surface warn.
- [ ] Tugboat and the chain playbook both call the shared helper. A path-local-only patch of one composer is not enough.
- [ ] Scope stays the waiter + fail detail + PR reuse. No `auto_merge`. No merge inside advance/loop. No implementation of #1096. No change to the detach-race product test (sibling #1111).

## Impact

- **Primary surfaces:** `examples/supervisor/shell/release-checks-green.py` (or a sibling shared helper), `examples/supervisor/shell/tugboat.sh` wait loop, `examples/supervisor/shell/pipeline-ship-playbook.sh` C0 wait, `failure_detail` in both composers, Option 1 pack parity if a new helper is added.
- **Tests:** `core/test/release-checks-green.test.ts`, `core/test/tugboat.test.ts` failure-detail cases, playbook field-schema test. New first-fail-then-pass and budget-exhausted fixtures.
- **Engine reuse:** `core/scripts/gh.ts` already exposes `rerunFailedWorkflows` (`gh run rerun <id> --failed`) and `getPrChecks` with `name,state,bucket,description,link`. Verified `gh pr checks --json` fields: `bucket`, `completedAt`, `description`, `event`, `link`, `name`, `startedAt`, `state`, `workflow`. There is no `conclusion` field.
- **Depends on:** none. Complements #1096 (in-engine ship recover). Complements sibling #1111 (stop producing the detach-race flake). Do not wait on either to land this waiter.
- **Out of scope:** implementing `pipeline ship`; changing pre-merge `ci-failure-classify` (infra vs assertion) so every assertion reruns; deleting or skipping the detach-race test; merge from advance/loop; a second ship brain.
- **Program:** v1.39.3.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** a ship/release waiter that treats any settled CI fail as terminal, without a bounded rerun of flake-eligible test jobs, and that leads fail notify with leftover train warns. **Site:** Tugboat/playbook release-finish wait on PR #1109 / run `32075787450`. |
| Shared surface? | New `ship-release-check-wait` classifier + `gh run rerun --failed` recipe + structured fail-detail helper. Tugboat and playbook adopt it. Later `pipeline ship` (#1096) must adopt the same law. |
| Next identical fault? | The next flake-eligible `test` fail on any ship waiter reruns once and waits. The next STOP names the check and run URL. It does not need a new mole issue. |
