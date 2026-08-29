## Context

See `proposal.md` for why. Current law and code:

- #1165 living `factory-reliability-gate` already requires FRG **collect** to re-observe GitHub ready-to-deploy plus green checks over a stale blocked ledger (`did not finish clean at ready-to-deploy`). That overlay lives in `githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` and is applied in `defaultCollectHybridV2FromRun` when it builds the collect bundle.
- `clean-item-throughput` still projects `ready_clean` from durable ledger `state` via `itemsFromLoopLedger`. `runFactoryGate --from-run` builds `computeInput.items` from that projector **before** collect overlay. Collect can succeed while throughput still reports `ready_clean=1` / `K=2`. `factory-release prepare` scores through `defaultScoreBoundPackLoop` → `runFactoryGate --from-run`.
- Durable reconciliation already maps verified `ready_label_present` to ledger `ready` and merged PR to `merged` (`verifiedForwardTarget`). `reconcile()` throws `LoopError("stop")` when `ledger.stop` is set. `driveSupervisor` resume swallows that class and does not repair-forward. `runSupervisorCycle` returns immediately when `ledger.stop` is set, so a live drive that just recorded `recovery_exhausted` does not continue. Existing test `resume of recovery_exhausted does not clear that stop or dispatch` encodes the no-op for a pending item without GitHub-ready identity.

**Conflict (do not average):** #1165 says collect scores GitHub-R2D as finished clean; throughput and resume still freeze on the stale ledger. This change extends the same class; it does not replace collect overlay.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Stale-ledger vs live GitHub ready-to-deploy.** Site symptom: pack item #1290 ledger `blocked` while GitHub is `pipeline:ready-to-deploy` / PR #1292 SUCCESS. The class is: live GitHub ready-to-deploy plus green checks on the **bound** PR is the source of truth for clean-ready. Shared surface: the `--from-run` scoring projection used by `clean-item-throughput` (factory-gate `--from-run` and prepare), not collect alone and not every `itemsFromLoopLedger` call.
2. **`recovery_exhausted` stop freezes terminal catch-up on `--resume`.** Site symptom: `--resume` returns without repair-forward because `ledger.stop` is set. The class is: a `recovery_exhausted` **resume** MUST still apply `ledger-behind` catch-up to verified `ready`/`merged`. It MUST NOT reopen a live drive. Shared surface: a resume-only catch-up entry in `driveSupervisor`, not a broad removal of `reconcile()`'s stop guard.

After this lands, the next pack item that is GitHub-R2D while the ledger is `blocked` + `recovery_exhausted` does **not** need a new mole issue.

## Goals / Non-Goals

**Goals:**

- One overlay class for GitHub-R2D plus green checks on the bound PR, reused by collect and `--from-run` throughput.
- Scoring overlay is independent of resume: `factory-gate --from-run` / prepare can score clean without a prior `--resume`.
- `--resume` of `recovery_exhausted` runs a **resume-only** terminal catch-up for verified `ready`/`merged` without deleting `ledger.stop` by hand.
- Existing resume test for a non-ready pending item still holds: no extra recovery dispatch.

**Non-Goals:**

- Auto-merge of pack PRs.
- Extra recovery budget for remaining blocked items that are not GitHub-ready.
- Treating `needs-human` as ready.
- Changing `run_fatal` resume (supersede + re-drive outstanding items).
- A second overlay rule that diverges from #1165 collect.
- Making `itemsFromLoopLedger` perform GitHub I/O.
- Removing `reconcile()`'s stop guard for live drives or for other stop reasons.
- Overlaying the `startLoop` factory-gate path (that path scores a loop it just drove and does not collect live GitHub today).

## Decisions

### Decision 1 — Reuse the #1165 overlay; apply it on the `--from-run` scoring path

`githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub` stay the single overlay class. A new **pure** helper (working name `projectFrgItemsWithGitHubOverlay`) takes `itemsFromLoopLedger(ledger)` plus **injected** per-item GitHub observations (`labels`, bound `pr_number`, `checks`) and returns the overlaid `FrgItemInput[]`. Production `--from-run` fills those observations from the **same** live issue/PR/check fetch `defaultCollectHybridV2FromRun` already performs (`selectPackPr` + checks on that PR's `headRefOid`). Tests inject the observations. No second GitHub crawl.

`itemsFromLoopLedger` stays a pure ledger projector. It SHALL NOT read GitHub.

**Caller inventory**

| Caller | File | Overlay? |
| --- | --- | --- |
| `runFactoryGate` `--from-run` `computeInput.items` | `factory-reliability-gate.ts` | **Yes** — live observations from collect (or injected) |
| `factory-release prepare` terminal score | `factory-release-prepare.ts` `defaultScoreBoundPackLoop` → `runFactoryGate --from-run` | **Yes** — same path |
| `runFactoryGate` `startLoop` `computeInput.items` | `factory-reliability-gate.ts` | **No** — ledger-only; this path scores a loop it just drove and does not collect hybrid-v2 GitHub |
| prepare ledger parse check | `factory-release-prepare.ts` (`itemsFromLoopLedger(ledger)` inside `try`) | **No** — shape check only, not throughput |
| unit projector tests | `factory-reliability-gate.test.ts` | **No** — ledger-only |

Rejected: bake GitHub I/O into `itemsFromLoopLedger`. That projector is used in unit tests without GitHub, and collect already owns the overlay helper.

### Decision 2 — Scoring overlay does not require resume

Ship-end success is `factory-gate --from-run` / prepare scoring clean while the durable ledger is still `blocked` + `recovery_exhausted`. Resume catch-up is a second, required surface so later ledger consumers and `--resume` do not need a human JSON edit. Alternative considered: score only after resume repairs the ledger. Rejected — the user story is scoring without editing `ledger.json`, and a pack that is already GitHub-R2D must not wait on a second supervisor drive.

### Decision 3 — Resume-only terminal catch-up; do not remove `reconcile()`'s stop guard

`--resume` of `recovery_exhausted` SHALL run a **resume-only** terminal catch-up pass that:

1. Observes live identity through the existing `ReconcileObserveDeps` seam (`observeExternalIdentity` / `verifiedForwardTarget`).
2. Repair-forwards an item only when the verified target is `ready` or `merged`.
3. Persists that ledger item state under the resume lock.
4. Performs **no** dispatch, **no** recovery-budget change, **no** GitHub write, and **no** `run_fatal` supersede.

`reconcile()` keeps `if (ledger.stop) throw LoopError("stop")`. A live drive that records `recovery_exhausted` still stops: `runSupervisorCycle` returns when `ledger.stop` is set and does not call this catch-up. The catch-up is invoked only from `driveSupervisor` when `input.resume === true` and `ledger.stop.reason === "recovery_exhausted"`, as a sibling of the existing `run_fatal` resume branch (that branch stays unchanged).

Catch-up SHALL NOT run the stranded `pr_opened` / `implemented` → `in_progress` heal. That heal is live-drive recovery, not terminal catch-up.

Rejected: clear `ledger.stop` on every resume so the existing `reconcile()` path runs. That reopens dispatch/recovery for remaining non-ready blocked items.

### Decision 4 — Bound PR and fail-closed overlay

Green checks MUST belong to the pack item's **bound** PR:

- Prefer `selectPackPr` (titled pack PR `(#N)`, same helper collect already uses).
- Checks MUST be the check-runs fetched for that PR's `headRefOid`, not another PR.
- If `selectPackPr` yields no PR, or GitHub issue/PR/checks are missing or unreadable, overlay SHALL NOT fire for that item (fail closed). Ledger state stands.
- Empty checks, pending/queued/in_progress conclusions, and failed conclusions SHALL NOT overlay to clean-ready.
- `pipeline:needs-human` without `pipeline:ready-to-deploy` SHALL NOT overlay to clean-ready.

Resume catch-up uses the loop identity seam (`findPrForIssue` / `getPrForIssueAnyState`), which is already the current linked PR. Missing identity → `verifiedForwardTarget` is `null` → no repair-forward.

### Decision 5 — Post-resume `ledger.stop` stays as historical evidence

After resume catch-up, `ledger.stop` **remains** with the original `recovery_exhausted` record (same `reason`, `time`, `item_id`). Catch-up writes item states only. It does not clear stop.

Consequences:

- Remaining non-ready blocked items stay exhausted: the next `runSupervisorCycle` still sees `ledger.stop` and does not dispatch.
- Operators do not need to delete `ledger.stop`; item state and FRG overlay are the catch-up products.
- Repeated `--resume` is idempotent: already-ready/merged items stay at that state; catch-up is a no-op for them; stop is unchanged; `dispatchItem` is still not called.

Rejected: clear stop when every item is terminal ready/merged. That would let the cycle loop run and is more than this issue needs. FRG overlay and persisted item `ready`/`merged` are sufficient.

### Decision 6 — Keep the existing non-ready resume test

The current test that resume of `recovery_exhausted` does not dispatch a pending item remains valid. New tests MUST fail without the fix (see tasks.md).

## Risks / Trade-offs

- **[Risk] Overlay treats empty or pending checks as green.** → Mitigation: reuse the #1165 helper; keep failed/pending/empty-check scenarios. Do not weaken collect.
- **[Risk] Overlay credits an unrelated historical PR.** → Mitigation: bind checks to `selectPackPr` + that PR's head SHA; fail closed when unbound.
- **[Risk] Removing `reconcile()`'s stop guard reopens a live drive or the `pr_opened` heal.** → Mitigation: resume-only catch-up; default `reconcile()` still throws on stop; live cycle still returns on `ledger.stop`.
- **[Risk] Clearing `ledger.stop` reopens recovery.** → Mitigation: Decision 5 keeps stop as historical evidence.
- **[Risk] Scoring overlay and resume catch-up drift.** → Mitigation: same GitHub-R2D class; both required; a scoring-only or resume-only mole is incomplete.
- **[Risk] `run_fatal` resume is confused with this path.** → Mitigation: specs keep `run_fatal` supersede-and-re-drive distinct; `recovery_exhausted` does not use that path.

## Migration Plan

No durable schema migration. Existing `recovery_exhausted` ledgers become scorable and resume-catch-up-able once this code ships. Operators do not need to rewrite on-disk `ledger.json`. Rollback is revert of the change; stale-ledger ship-end fails as today.

## Open Questions

_(none)_
