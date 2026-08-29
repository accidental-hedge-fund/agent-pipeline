## 1. Regression tests that bite #1297

- [x] 1.1 Add a unit test that scores `factory-gate --from-run` on a two-item pack with ledger `#1290=blocked`, `stop.reason=recovery_exhausted`, sibling already ready, and bound-PR R2D plus green checks on `#1290`; verify it fails while `clean-item-throughput` observed is `1` / `K=2`
- [x] 1.2 Add a unit test that scores `factory-release prepare` / `defaultScoreBoundPackLoop` on that same ledger and GitHub overlay; verify it fails while observed is `1` / `K=2`
- [x] 1.3 Add a unit test that resumes that same stopped ledger with verified ready identity; verify it fails while resume never repair-forwards / never persists ledger `ready` for the R2D item
- [x] 1.4 Add fail-closed overlay tests: missing R2D label, failed checks, pending checks, absent PR, wrong/unbound PR, unreadable GitHub, and `needs-human` stay not clean-ready
- [x] 1.6 Add fail-closed overlay tests for a ledger-ready item with missing or unbound GitHub observations (clear `ready_clean`, project ineligible)
- [x] 1.7 Add fail-closed overlay tests for ledger `merged` and `released` with missing, unbound, non-R2D, and failed/pending-check observations (clear `ready_clean`, project ineligible; preserve terminal only when live observation proves the class)
- [x] 1.5 Add a resume test that repair-forwards verified `merged` identity as well as `ready`

## 2. FRG throughput overlay

- [x] 2.1 Thread per-item GitHub observations (labels, bound PR via `selectPackPr`, checks on that PR head) out of collect / `--from-run` without a second GitHub crawl
- [x] 2.2 Apply `githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` on the from-run / prepare scoring path before `clean-item-throughput` counts `ready_clean`; verify tests 1.1 and 1.2 pass and collect overlay tests still pass
- [x] 2.3 Keep `itemsFromLoopLedger` as a pure ledger projector with no GitHub I/O; verify existing projection tests still pass
- [x] 2.4 Leave the factory-gate `startLoop` scoring path ledger-only
- [x] 2.5 Verify test 1.4 (fail-closed) passes

## 3. Resume-only terminal catch-up

- [x] 3.1 Add a resume-only catch-up entry on `driveSupervisor` when `resume === true` and `stop.reason === recovery_exhausted`; reuse `verifiedForwardTarget` for `ready`/`merged` only; do not remove `reconcile()`'s stop guard
- [x] 3.2 Persist ledger `ready`/`merged` without a human `ledger.stop` delete; keep `ledger.stop` as historical evidence; verify test 1.3 passes
- [x] 3.3 Keep remaining blocked items that are not GitHub-ready exhausted (no extra recovery dispatch, no `dispatchItem` calls, no GitHub writes); verify a unit test asserts that
- [x] 3.4 Keep `needs-human` from being repair-forwarded to `ready`; verify a unit test asserts ledger state stays not-ready
- [x] 3.5 Keep `run_fatal` resume on the supersede-and-re-drive path; verify existing `run_fatal` resume tests still pass
- [x] 3.6 Keep resume of `recovery_exhausted` from dispatching a pending item that is not GitHub-ready; verify existing `resume of recovery_exhausted does not clear that stop or dispatch` still passes
- [x] 3.7 Verify repeated `--resume` is idempotent (already-ready item stays ready; stop unchanged; no dispatch)
- [x] 3.8 Verify a live drive that records `recovery_exhausted` still stops and does not enter catch-up
- [x] 3.9 Verify default `reconcile()` still throws `LoopError("stop")` when `ledger.stop` is set

## 4. OpenSpec, mirror, and CI

- [x] 4.1 Keep this change's delta specs aligned with resume-only catch-up, bound-PR fail-closed overlay, and the `itemsFromLoopLedger` caller inventory
- [x] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes
- [x] 4.3 Run `openspec validate recovery-exhausted-github-r2d-catch-up`, `git diff --check`, and `npm run ci`; verify all are green
