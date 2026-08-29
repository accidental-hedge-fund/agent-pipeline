## 1. Regression tests that bite #1297

- [ ] 1.1 Add a unit test that scores a two-item pack with ledger `#1290=blocked`, `stop.reason=recovery_exhausted`, sibling already ready, and GitHub R2D plus green checks on `#1290`; verify it fails while `clean-item-throughput` observed is `1` / `K=2`
- [ ] 1.2 Add a unit test that resumes that same stopped ledger with verified ready identity; verify it fails while resume never repair-forwards / never persists ledger `ready` for the R2D item

## 2. FRG throughput overlay

- [ ] 2.1 Apply the existing #1165 GitHub ready-to-deploy plus green-checks overlay on the from-run / prepare scoring path before `clean-item-throughput` counts `ready_clean`; verify test 1.1 passes and collect overlay tests still pass
- [ ] 2.2 Keep `itemsFromLoopLedger` as a pure ledger projector when no GitHub identity is supplied; verify existing `itemsFromLoopLedger` projection tests still pass
- [ ] 2.3 Add negative coverage: missing R2D label, failed or pending checks, and `needs-human` stay not clean-ready; verify those tests pass

## 3. Resume terminal catch-up

- [ ] 3.1 Make `recovery_exhausted` resume run terminal `ledger-behind` catch-up to verified `ready`/`merged` without requiring a human `ledger.stop` delete; verify test 1.2 passes
- [ ] 3.2 Keep remaining blocked items that are not GitHub-ready exhausted (no extra recovery dispatch); verify a unit test asserts no dispatch for those items
- [ ] 3.3 Keep `needs-human` from being repair-forwarded to `ready`; verify a unit test asserts ledger state stays not-ready
- [ ] 3.4 Keep `run_fatal` resume on the supersede-and-re-drive path; verify existing `run_fatal` resume tests still pass
- [ ] 3.5 Keep resume of `recovery_exhausted` from dispatching a pending item that is not GitHub-ready; verify existing `resume of recovery_exhausted does not clear that stop or dispatch` still passes

## 4. Mirror and CI

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes
- [ ] 4.2 Run `openspec validate recovery-exhausted-github-r2d-catch-up` and `npm run ci`; verify both are green
