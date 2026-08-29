## Context

See `proposal.md` for why. Current law and code:

- #1165 living `factory-reliability-gate` already requires FRG **collect** to re-observe GitHub ready-to-deploy plus green checks over a stale blocked ledger (`did not finish clean at ready-to-deploy`). That overlay lives in `githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` and is applied in `defaultCollectHybridV2FromRun`.
- `clean-item-throughput` still projects `ready_clean` from durable ledger `state` via `itemsFromLoopLedger`. `runFactoryGate --from-run` and `factory-release prepare` call that projector on the raw ledger. Collect can succeed while throughput still reports `ready_clean=1` / `K=2`.
- Durable reconciliation already maps verified `ready_label_present` to ledger `ready` and merged PR to `merged` (`verifiedForwardTarget`). `reconcile()` throws `LoopError("stop")` when `ledger.stop` is set. `driveSupervisor` swallows that class and does not repair-forward. Existing test `resume of recovery_exhausted does not clear that stop or dispatch` encodes the no-op for a pending item without GitHub-ready identity.

**Conflict (do not average):** #1165 says collect scores GitHub-R2D as finished clean; throughput and resume still freeze on the stale ledger. This change extends the same class; it does not replace collect overlay.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Stale-ledger vs live GitHub ready-to-deploy.** Site symptom: pack item #1290 ledger `blocked` while GitHub is `pipeline:ready-to-deploy` / PR #1292 SUCCESS. The class is: live GitHub ready-to-deploy plus green checks is the source of truth for clean-ready. Shared surfaces: every `itemsFromLoopLedger` consumer that scores `clean-item-throughput` (from-run factory-gate and prepare), not collect alone.
2. **`recovery_exhausted` stop freezes terminal catch-up.** Site symptom: `--resume` returns without repair-forward because `ledger.stop` is set. The class is: a `recovery_exhausted` stop MUST NOT skip `ledger-behind` catch-up to verified `ready`/`merged`. Shared surfaces: reconcile (terminal repair) and supervisor resume (must invoke that repair). A resume-only mole that still scores from the raw ledger leaves the next ship failing `frg_not_eligible`. A scoring-only mole leaves the next `--resume` still requiring a human `ledger.json` edit.

After this lands, the next pack item that is GitHub-R2D while the ledger is `blocked` + `recovery_exhausted` does **not** need a new mole issue.

## Goals / Non-Goals

**Goals:**

- One overlay class for GitHub-R2D plus green checks, reused by collect and throughput.
- Scoring overlay is independent of resume: `factory-gate --from-run` / prepare can score clean without a prior `--resume`.
- Resume of `recovery_exhausted` reaches terminal repair-forward for verified `ready`/`merged` without deleting `ledger.stop`.
- Existing resume test for a non-ready pending item still holds: no extra recovery dispatch.

**Non-Goals:**

- Auto-merge of pack PRs.
- Extra recovery budget for remaining blocked items that are not GitHub-ready.
- Treating `needs-human` as ready.
- Changing `run_fatal` resume (supersede + re-drive outstanding items).
- A second overlay rule that diverges from #1165 collect.

## Decisions

### Decision 1 — Reuse the #1165 overlay; apply it on the scoring path

`githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` stay the single overlay class. `runFactoryGate --from-run` (and prepare, which scores through that path) SHALL overlay live GitHub identity onto each pack item **before** `clean-item-throughput` counts `ready_clean`. Collect already overlays. Do not invent a second predicate.

`itemsFromLoopLedger` MAY stay a pure ledger projector for callers that have no GitHub identity. Consumers that score a live pack MUST overlay first. Alternative considered: bake GitHub I/O into `itemsFromLoopLedger`. Rejected — that projector is used in unit tests without GitHub, and collect already owns the overlay helper.

### Decision 2 — Scoring overlay does not require resume

Ship-end success is `factory-gate --from-run` / prepare scoring clean while the durable ledger is still `blocked` + `recovery_exhausted`. Resume catch-up is a second, required surface so later ledger consumers and `--resume` do not need a human JSON edit. Alternative considered: score only after resume repairs the ledger. Rejected — the user story is scoring without editing `ledger.json`, and a pack that is already GitHub-R2D must not wait on a second supervisor drive.

### Decision 3 — Resume catch-up is terminal repair, not `run_fatal` supersede

`--resume` of `recovery_exhausted` SHALL run reconciliation's existing terminal catch-up (`ready_label_present` → ledger `ready`, merged PR → `merged`) even though `ledger.stop` is set. It SHALL NOT supersede the stop to reopen recovery budget (that is the `run_fatal` path). Remaining blocked items without GitHub-ready identity stay exhausted. `needs-human` stays not-ready.

Implementation shape (not a spec contract): either (a) allow reconcile to run terminal `ledger-behind` repair when stop is `recovery_exhausted`, then keep stop if any non-terminal blocked item remains, or (b) a resume-only catch-up pass that applies the same `verifiedForwardTarget` transitions without a full live re-drive. Either shape is valid if the observable outcomes hold.

Alternative considered: clear `ledger.stop` on resume so the existing reconcile path runs. Rejected as the primary recipe — that reopens dispatch/recovery for remaining non-ready blocked items and contradicts unlimited-recovery non-goal. Clearing stop only after **all** items are terminal ready/merged is allowed as an implementation detail of all-done completion.

### Decision 4 — Keep the existing non-ready resume test

The current test that resume of `recovery_exhausted` does not dispatch a pending item remains valid. New tests MUST fail without the fix:

1. Two-item pack, `#1290=blocked` + `stop.reason=recovery_exhausted` + GitHub R2D/green, sibling already ready → `clean-item-throughput` observed is not `1` / `K=2`.
2. Resume with that stop and verified ready identity calls repair-forward (or persists ledger `ready`) for the R2D item.

## Risks / Trade-offs

- **[Risk] Overlay treats empty or pending checks as green.** → Mitigation: reuse the #1165 helper; keep the failed/pending scenarios. Do not weaken collect.
- **[Risk] Resume that clears `ledger.stop` reopens recovery.** → Mitigation: catch-up is terminal-only; remaining non-ready blocked items stay exhausted; unit test asserts no dispatch for those items.
- **[Risk] Scoring overlay and resume catch-up drift.** → Mitigation: same GitHub-R2D class; both required; a scoring-only or resume-only mole is incomplete.
- **[Risk] `run_fatal` resume is confused with this path.** → Mitigation: specs keep `run_fatal` supersede-and-re-drive distinct; `recovery_exhausted` does not use that path.

## Migration Plan

No durable schema migration. Existing `recovery_exhausted` ledgers become scorable and resume-catch-up-able once this code ships. Operators do not need to rewrite on-disk `ledger.json`. Rollback is revert of the change; stale-ledger ship-end fails as today.

## Open Questions

_(none)_
