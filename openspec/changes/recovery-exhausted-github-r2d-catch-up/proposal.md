## Why

Pack loop `loop-15af2f73748bf10e` item #1290 stopped `recovery_exhausted` (`implementation-ci`) while CI was still progressing. A sibling `pipeline single 1290 --engine-track candidate` later reached `pipeline:ready-to-deploy` (PR #1292, checks SUCCESS). GitHub was ahead of the pack ledger (#1290 still `blocked`). `--resume` did not catch up because `reconcile()` throws when `ledger.stop` is set, and `driveSupervisor` swallows that `LoopError("stop")` without repair-forward. FRG `clean-item-throughput` still projects from ledger `state` via `itemsFromLoopLedger`, so the scoreboard was `ready_clean=1` / `K=2` and prepare failed `frg_not_eligible`. A human had to delete `ledger.stop` so resume could repair-forward.

#1165 closed 2026-08-20 covering **collect** only (`did not finish clean at ready-to-deploy`). Throughput and resume still trust the stale ledger. That is a class gap, not a duplicate of #1165.

## What Changes

- **FRG throughput scores live GitHub ready-to-deploy.** `factory-gate --from-run`, `factory-release prepare`, and every other `itemsFromLoopLedger` consumer SHALL count a pack item as `ready_clean` when GitHub shows `pipeline:ready-to-deploy` and the bound PR checks are green, even when the durable ledger says `blocked` and `stop.reason=recovery_exhausted`.
- **Resume of `recovery_exhausted` runs terminal catch-up.** `pipeline loop --resume` SHALL observe live identity and repair-forward items whose verified identity is `ready` or `merged`. It SHALL NOT no-op solely because `ledger.stop` is set.
- **No human ledger edit.** Operators SHALL NOT need to delete `ledger.stop` or rewrite item state for GitHub-R2D catch-up.
- **Non-goals stay non-goals.** No auto-merge of pack PRs. No extra recovery budget for items that are not GitHub-ready. `needs-human` is not treated as ready.

This is a **class** fix, not a #1290 mole. The class is: live GitHub ready-to-deploy (plus green checks) is the source of truth for clean-ready; a `recovery_exhausted` stop MUST NOT freeze ledger-behind terminal catch-up or FRG throughput. Shared surfaces are FRG scoring (`itemsFromLoopLedger` consumers, including `clean-item-throughput`) and loop resume/reconcile (terminal repair-forward). After this change, the next pack item that is GitHub-R2D while the ledger is `blocked` + `recovery_exhausted` does not need a new mole issue.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `factory-reliability-gate`: `clean-item-throughput` and other `itemsFromLoopLedger` consumers overlay GitHub ready-to-deploy + green checks over a stale blocked ledger and `recovery_exhausted` stop. Collect overlay from #1165 stays; throughput MUST use the same overlay class.
- `durable-loop-supervisor`: `--resume` of a run stopped `recovery_exhausted` SHALL run terminal repair-forward for items whose verified identity is `ready`/`merged`, and SHALL NOT no-op solely because `ledger.stop` is set.
- `durable-run-reconciliation`: terminal `ledger-behind` catch-up to `ready`/`merged` SHALL remain reachable on a `recovery_exhausted` stop (resume catch-up). Reconcile SHALL NOT skip that repair solely because `ledger.stop` is set.

## Impact

- `core/scripts/factory-reliability-gate.ts` (`itemsFromLoopLedger` / from-run scoring)
- `core/scripts/factory-release-prepare.ts` (prepare score from the bound pack ledger)
- `core/scripts/frg-hybrid-v2-from-run.ts` (reuse the existing GitHub overlay; do not invent a second rule)
- `core/scripts/loop/reconcile.ts` and `core/scripts/loop/supervisor.ts` (resume of `recovery_exhausted` must reach repair-forward)
- Unit tests that bite the #1290 scoreboard (`ready_clean=1` / `K=2`) and the resume no-op. Tests inject I/O via deps. `plugin/` regenerates if `core/` is edited later.

## Acceptance Criteria

- [ ] When GitHub shows pack item N as `pipeline:ready-to-deploy` with green checks, FRG throughput / `itemsFromLoopLedger` consumers count N as clean-ready even if the durable ledger says `blocked` or `stop.reason=recovery_exhausted`.
- [ ] `factory-gate --from-run` / prepare scoring of a two-item pack with ledger `#1290=blocked` + `stop.reason=recovery_exhausted` + GitHub R2D/green on #1290 does **not** yield `clean-item-throughput` observed 1 / `K=2` solely because the ledger is stale.
- [ ] `pipeline loop --resume` of a run stopped `recovery_exhausted` runs repair-forward for items whose verified identity is `ready`/`merged`. It does not no-op solely because `ledger.stop` is set.
- [ ] After that resume, item N is ledger `ready` (or equivalent terminal ready state) without a human deleting `ledger.stop` or rewriting item JSON.
- [ ] Resume does **not** grant extra recovery budget for remaining blocked items that are not GitHub-ready. It does **not** treat `needs-human` as ready. It does **not** merge pack PRs.
- [ ] A unit test fails if ledger `#1290=blocked` + `stop.reason=recovery_exhausted` + GitHub R2D/green still yields `clean-item-throughput` observed 1 / `K=2` for a two-item pack.
- [ ] A unit test fails if resume with that stop never calls repair-forward for the R2D item.
- [ ] After any later `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change. `npm run ci` is green.

## Non-goals

- Auto-merge of pack PRs
- Unlimited recovery budget
- Treating `needs-human` as ready
- Reversing #1165 collect overlay (this change extends the same class to throughput and resume)
- Changing `run_fatal` resume (supersede + re-drive outstanding items)
