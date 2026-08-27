## Context

See `proposal.md` for why. Current law and code:

- Living `durable-loop-supervisor` says `--resume` attaches when the prior holder is gone, reconciles, and continues from the ledger's current position. `runSupervisorCycle` returns immediately when `ledger.stop` is set. Resume of a `run_fatal` run therefore records `resumed: true`, dispatches nothing, and re-emits the old stop.
- `reconcile` and item transitions throw `LoopError("stop")` while `ledger.stop` is set (`durable-loop-engine`: a stopped run refuses every further transition). `driveSupervisor` swallows that error on resume, then the first cycle hits the same stop.
- `run_fatal` remains the correct live-drive terminal for `workflow-engine-defect` and other `run_fatal: true` classes. This change does not alter that policy. The hole is the operator resume path after the supervisor is already dead.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is FRG pack `loop-68575cf7a09c849c` (`workflow-engine-defect` after doctor `worktree-clean`). The class is: operator `--resume` of a terminal `run_fatal` must re-evaluate live outstanding items at the same run id, then either re-drive or refuse. A pack-local special case in `factory-release prepare` is a mole.
2. **Shared surfaces.** Resume-time eligibility lives in the supervisor attach/drive path. Stop supersede lives in the ledger/event store. Transition permission follows from clearing `ledger.stop`. Loop CLI maps ineligible resume to a distinct error envelope. No new recovery recipe, no second recoverer in `train.ts`, no classification change.
3. **Next identical fault.** The next pack (or any selector) that fatals on a transient environment cause, then `--resume` after the cause is gone, hits the same gate. Tests fail if that resume still exits `dispatched: 0` with no refusal, or if an empty outstanding set still prints `resumed: true` / `dispatched: 0`.

## Goals / Non-Goals

**Goals:**

- Make operator `--resume` of `run_fatal` a fail-safe re-drive or a distinct refusal.
- Keep the same run id when outstanding items remain valid.
- Preserve append-only stop history (original stop event stays).
- Bite with injected supervisor tests on the FRG shape and on the empty-outstanding refusal.

**Non-Goals:**

- Changing `run_fatal` flags or live-drive classification (`recovery.ts` policy).
- Auto-retry inside a dead supervisor without `--resume`.
- Re-driving other stop reasons (`recovery_exhausted`, `human_authority`, `supervisor_no_progress`, `dependency_deadlock`) in this change.
- Native `/goal` fallback; merge inside advance/loop; a new pack protocol in factory-release.

## Decisions

### 1. Resume-time eligibility is a shared classifier, not a theme allowlist (primary)

**Choice:** After `--resume` attaches and before `loop_drive_started` / early handoff, if `ledger.stop.reason === "run_fatal"`, observe live item identities (read-only) and classify each contract item as valid-outstanding or not. Valid-outstanding means: not done/abandoned/skipped; not a current human-authority hold (`paused`/`waiting` with hold, or blocked under a human-authority class); live labels still admit the item under the existing loop precondition gate. If at least one item is valid-outstanding, supersede the stop and continue the normal resume cycle. If none are, refuse.

**Why:** The FRG case is environment hygiene, not a special theme. A theme allowlist would miss the next transient cause (auth flake, doctor check, host dirt) and mint another mole. Item validity is the class predicate the issue already names.

**Alternatives considered:**

- Always clear any `run_fatal` and re-drive without an eligibility check → rejected. A fully spent or human-held run would look like a successful zero-dispatch resume again.
- Theme allowlist (`workflow-engine-defect` only, or environment-like themes) → rejected. Class-over-site requires the next identical *fault* (stale fatal + valid items), not the next identical theme.
- Require `--force` / `--redrive` → rejected. The issue's user story is that `--resume` itself is the operator invocation. A second flag leaves the silent no-op as default.

### 2. Supersede by clearing `ledger.stop`; do not rewrite the original stop event

**Choice:** Eligible re-drive writes a new ledger with `stop` absent, under the run lock, and appends one event (kind such as `loop_run_fatal_superseded`) whose payload copies the prior stop record (`reason`, `time`, `theme`, `item_id`, `outstanding_ready`). The original `loop_run_stopped` line stays. Action-evidence records the supersede as progress. If the re-drive fatals again, a **new** `loop_run_stopped` event is appended for the new stop. Tests lock the event kind string.

**Why:** Store law is append-only logs plus atomic ledger documents. A `stop_history` array on the ledger is a schema change we do not need. Auditors reconstruct from events. Clearing `stop` is what makes reconcile and transitions legal under existing engine law (a run that no longer carries a stop).

**Alternatives considered:**

- Keep `ledger.stop` and add `resume_override` / `stop.superseded_at` that cycles consult → rejected. Every stop guard (`reconcile`, `blockItem`, `transitionItem`, `enterHold`, recovery) would need a second exception. Clearing the field reuses the existing "no stop" path.
- Rewrite or delete the original stop event → rejected. Append-only.

### 3. Distinct refusal is a command-level error, not a fake successful drive

**Choice:** Ineligible `run_fatal` resume returns `kind: "error"` (or the loop engine's existing error result) with a message that includes the recorded `time`, `theme`, `item_id` when present, and a recommended command: inspect with `pipeline loop --resume <run-id> --audit`; start a replacement with `pipeline loop --new-run` for the same selector. Exit non-zero. Do not emit the terminal drive summary JSON (`resumed: true`, `dispatched: 0`, echoed `stop`). Do not emit `loop_drive_started`. Release the lock in `finally` as today.

**Why:** Today's exit code is already 1 because `result.stop` is set, so exit status alone is not distinct. Factory-release and operators parsed `resumed: true, dispatched: 0` as a completed resume. The success envelope is the silent no-op.

**Alternatives considered:**

- Keep the summary JSON and add `refusal: true` → weaker. Consumers already key on `resumed` + `dispatched`. A new field is easy to ignore.
- Re-record the same stop and return the summary → that is the bug.

### 4. Eligibility observe is allowed while the stop is still set

**Choice:** The resume-time classifier reads the ledger (including `stop`) and calls the existing observe seam for live labels. It MUST NOT call `reconcile` (reconcile writes and currently throws on stop). It MUST NOT dispatch. After a yes-eligible decision, clear `stop`, then run the existing resume reconcile + cycle loop. Tests inject observe + dispatch and assert dispatch is not called on the refuse path.

**Why:** Reconcile is the wrong tool: it mutates and is stop-gated. A pure function over ledger items + observed identities is the testable classifier.

**Alternatives considered:**

- Clear stop first, then reconcile, then maybe refuse → rejected. Clearing first leaves a non-terminal run if we then refuse.
- Use last_reconciliation without a fresh observe → stale. The FRG case is exactly that live truth changed (checkout cleaned; labels still admitted).

### 5. `dispatched: 0` after a successful re-drive that immediately re-fatals is not the silent no-op

**Choice:** The silent no-op is: dispatch seam never called, original stop timestamp still the terminal outcome, success summary printed. A re-drive that calls dispatch and records a **new** stop (new `time`) is a real drive. The biting test for AC4 uses a dispatch fake that succeeds (item reaches done) so `dispatched > 0` and the original stop is gone. A second test uses a dispatch fake that fails fatally again and asserts the stop `time` changed and dispatch was called. The refuse test asserts dispatch was not called.

**Why:** `dispatched` in today's summary is "done or abandoned count", not "calls this drive". Specifying only `dispatched: 0` would false-fail a genuine re-fatal. Tests must assert the dispatch seam and stop identity.

### 6. Other stop reasons stay refuse-all

**Choice:** This gate keys on `stop.reason === "run_fatal"` only. `human_authority`, `recovery_exhausted`, `supervisor_no_progress`, `dependency_deadlock`, `worktree_capacity`, and the rest keep today's early return (or existing refusal). A later change can extend the classifier; this issue's evidence is `run_fatal`.

**Why:** Issue out of scope and surgical coexistence. Broadening would mix human-authority holds into auto-redrive.

## Risks / Trade-offs

- [Re-drive retries a genuine engine defect] → Mitigation: live-drive policy still `run_fatal`s again. Operator chose `--resume`. New stop gets a new time. Not a silent no-op.
- [Two operators resume the same fatal run] → Mitigation: existing exclusive run lock. Second attach refuses a live holder.
- [Eligibility observe is stale or fails] → Mitigation: observe failure fail-closes to the distinct refusal (do not clear the stop, do not dispatch), naming that observe failed. Do not treat observe failure as "valid items exist".
- [Follow consumers see two `loop_run_stopped` lines] → Mitigation: existing `loop_drive_started` already supersedes an earlier resumable completion (`logs.ts`). Re-drive emits `loop_drive_started` after supersede. Document that a later stop is a new terminal.

## Migration Plan

- No on-disk schema migration. Pre-change ledgers with `stop.reason = run_fatal` become re-driveable on the first `--resume` after this ships.
- Rollback: revert the supervisor gate; old silent no-op returns. No data rewrite to undo.

## Open Questions

None. Event kind string and refusal message tokens are locked by tests at implementation time and do not change the requirements.
