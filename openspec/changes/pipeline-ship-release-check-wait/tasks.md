## 1. Shared TypeScript waiter

- [x] 1.1 Add a core helper that classifies a `gh pr checks --json` capture as exactly one of `green` / `pending` / `rerun` / `fail` from `name`, `state`, `bucket`, and `link`, and verify it never reads a `conclusion` field
- [x] 1.2 Apply pending-first over the whole set (pending plus fail is `pending`) and verify a mixed pending+fail fixture is not `rerun` or `fail`
- [x] 1.3 Treat a settled fail as `rerun` only when every failed check name is flake-eligible (default allowlist includes `test`) and verify a non-test product fail and a mixed fail classify as `fail` with no rerun request

## 2. Finish-converge wait and bounded rerun

- [x] 2.1 Call the waiter from `convergeReleaseFinish` (or a seam it calls) before `operations.finishRelease`, and verify finish is not invoked while the waiter classifies `pending` or `rerun`
- [x] 2.2 On `pending`, poll in-process through an injected clock with a ship-ledger heartbeat, and verify a one-shot throw on pending does not persist ship failure
- [x] 2.3 On `rerun`, request `gh run rerun --failed` once per head SHA (budget does not exceed two), persist the attempt, resume wait, and verify a missing run id or failed rerun request classifies as `fail` without looping
- [x] 2.4 On `green`, invoke finish for the same open PR; on `fail`, persist ship failure without finish; verify already-observed merged finish evidence skips wait and does not merge again
- [x] 2.5 Leave bare `finishReleasePr` as a one-shot snapshot gate, and verify `release-finish` tests still fail closed on one pending or fail capture

## 3. Regression tests

- [x] 3.1 Add a unit test that fails if `convergeReleaseFinish` (or the seam it calls) invokes finish while the waiter would classify `pending`; prove it fails against the current one-shot finish
- [x] 3.2 Add a unit test that fails if a settled flake-eligible `test` fail does not request `gh run rerun --failed` before a second wait
- [x] 3.3 Inject `gh` and clock via `deps` in both tests, and verify they make no live network, git, or Actions calls
- [x] 3.4 Keep the already-finished observation fixture green (no wait and no second merge when finish evidence is already observed)
- [x] 3.5 Add a coordinator-state test that exhausts the pending wait cap and verifies the stored run remains resumable at `release_finish` without persisted ship failure
- [x] 3.6 Add a regression test that changes the observed release-PR head during a pending wait and proves no rerun and no finish under the stale identity
- [x] 3.7 Add a regression test that unreadable persisted rerun-budget state is treated as exhausted and issues no additional rerun; persist writes through temp+rename

## 4. Docs, packaging, gate

- [x] 4.1 Update `docs/runbooks/ship-milestone.md` so the in-engine path waits with `ship-release-check-wait` before `release finish`, and verify the runbook no longer implies Tugboat is the only waiter
- [x] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 4.3 Run `openspec validate pipeline-ship-release-check-wait` and `npm run ci` from the repo root, and fix failures until green
