## Why

Pack loop `loop-15af2f73748bf10e` item #1290 stopped `recovery_exhausted` (`implementation-ci`) while CI was still progressing. A sibling `pipeline single 1290 --engine-track candidate` later reached `pipeline:ready-to-deploy` (PR #1292, checks SUCCESS). GitHub was ahead of the pack ledger (#1290 still `blocked`). `--resume` did not catch up because `reconcile()` throws when `ledger.stop` is set, and `driveSupervisor` swallows that `LoopError("stop")` without repair-forward. FRG `clean-item-throughput` still projects from ledger `state` via `itemsFromLoopLedger`, so the scoreboard was `ready_clean=1` / `K=2` and prepare failed `frg_not_eligible`. A human had to delete `ledger.stop` so resume could repair-forward.

#1165 closed 2026-08-20 covering **collect** only (`did not finish clean at ready-to-deploy`). Throughput and resume still trust the stale ledger. That is a class gap, not a duplicate of #1165.

## What Changes

- **FRG `--from-run` throughput scores live GitHub ready-to-deploy.** `factory-gate --from-run` and `factory-release prepare` (which scores through that path) SHALL count a pack item as `ready_clean` when GitHub shows `pipeline:ready-to-deploy` and the **bound** PR checks are green, even when the durable ledger says `blocked` and `stop.reason=recovery_exhausted`. The overlay SHALL reuse `githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` with injected observations from the same collect fetch. `itemsFromLoopLedger` SHALL stay a pure projector (no GitHub I/O).
- **Resume of `recovery_exhausted` runs resume-only terminal catch-up.** `pipeline loop --resume` SHALL observe live identity and repair-forward items whose verified identity is `ready` or `merged`. It SHALL NOT no-op solely because `ledger.stop` is set. It SHALL NOT remove `reconcile()`'s stop guard for live drives. It SHALL NOT dispatch, change recovery budget, write GitHub, or use the `run_fatal` path.
- **No human ledger edit.** Operators SHALL NOT need to delete `ledger.stop` or rewrite item state for GitHub-R2D catch-up. After resume, `ledger.stop` remains as historical evidence.
- **Non-goals stay non-goals.** No auto-merge of pack PRs. No extra recovery budget for items that are not GitHub-ready. `needs-human` is not treated as ready.

This is a **class** fix, not a #1290 mole. The class is: live GitHub ready-to-deploy (plus green checks on the bound PR) is the source of truth for clean-ready; a `recovery_exhausted` stop MUST NOT freeze resume terminal catch-up or `--from-run` FRG throughput. After this change, the next pack item that is GitHub-R2D while the ledger is `blocked` + `recovery_exhausted` does not need a new mole issue.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `factory-reliability-gate`: `clean-item-throughput` on `factory-gate --from-run` and `factory-release prepare` overlays GitHub ready-to-deploy + bound-PR green checks over a stale blocked ledger and `recovery_exhausted` stop. Collect overlay from #1165 stays; throughput MUST use the same overlay class. `itemsFromLoopLedger` stays pure. The `startLoop` factory-gate path stays ledger-only.
- `durable-loop-supervisor`: `--resume` of a run stopped `recovery_exhausted` SHALL run a resume-only terminal catch-up for items whose verified identity is `ready`/`merged`, and SHALL NOT no-op solely because `ledger.stop` is set. A live drive that records `recovery_exhausted` still stops. `run_fatal` resume is unchanged.
- `durable-run-reconciliation`: terminal `ledger-behind` catch-up to `ready`/`merged` SHALL remain reachable on `--resume` of a `recovery_exhausted` stop through that resume-only pass. Default `reconcile()` SHALL keep refusing when `ledger.stop` is set.

## Impact

- `core/scripts/factory-reliability-gate.ts` (`--from-run` scoring projection; not the body of `itemsFromLoopLedger`)
- `core/scripts/factory-release-prepare.ts` (prepare scores through `defaultScoreBoundPackLoop` → `--from-run`)
- `core/scripts/frg-hybrid-v2-from-run.ts` (reuse `githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` / `selectPackPr`; thread per-item observations out of collect)
- `core/scripts/loop/supervisor.ts` (resume-only catch-up sibling of the `run_fatal` resume branch)
- `core/scripts/loop/reconcile.ts` (`verifiedForwardTarget` reuse; **keep** the `ledger.stop` throw on default `reconcile()`)
- Unit tests that bite the #1290 scoreboard (`ready_clean=1` / `K=2`) and the resume no-op. Tests inject I/O via deps. `plugin/` regenerates if `core/` is edited later.

## Acceptance Criteria

- [ ] When GitHub shows pack item N as `pipeline:ready-to-deploy` with green checks on the bound PR, `factory-gate --from-run` / prepare `clean-item-throughput` counts N as clean-ready even if the durable ledger says `blocked` or `stop.reason=recovery_exhausted`.
- [ ] `factory-gate --from-run` / prepare scoring of a two-item pack with ledger `#1290=blocked` + `stop.reason=recovery_exhausted` + GitHub R2D/green on #1290 does **not** yield `clean-item-throughput` observed 1 / `K=2` solely because the ledger is stale.
- [ ] `pipeline loop --resume` of a run stopped `recovery_exhausted` runs resume-only repair-forward for items whose verified identity is `ready`/`merged`. It does not no-op solely because `ledger.stop` is set.
- [ ] After that resume, item N is ledger `ready` (or equivalent terminal ready state) without a human deleting `ledger.stop` or rewriting item JSON. `ledger.stop` remains as historical evidence.
- [ ] Resume does **not** grant extra recovery budget for remaining blocked items that are not GitHub-ready. It does **not** treat `needs-human` as ready. It does **not** merge pack PRs. It does **not** dispatch. It does **not** write GitHub. Default `reconcile()` still throws when `ledger.stop` is set.
- [ ] Overlay is fail-closed: missing/unreadable GitHub, absent PR, wrong (unbound) PR, pending/failed checks, and `needs-human` without R2D do not count as clean-ready.
- [ ] A unit test fails if ledger `#1290=blocked` + `stop.reason=recovery_exhausted` + GitHub R2D/green still yields `clean-item-throughput` observed 1 / `K=2` for a two-item pack.
- [ ] A unit test fails if resume with that stop never calls repair-forward for the R2D item.
- [ ] Repeated `--resume` of the same exhausted run is idempotent (item states stable; no dispatch).
- [ ] After any later `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change. `npm run ci` is green.

## Non-goals

- Auto-merge of pack PRs
- Unlimited recovery budget
- Treating `needs-human` as ready
- Reversing #1165 collect overlay (this change extends the same class to `--from-run` throughput and resume)
- Changing `run_fatal` resume (supersede + re-drive outstanding items)
- GitHub I/O inside `itemsFromLoopLedger`
- Removing `reconcile()`'s stop guard on live drives
