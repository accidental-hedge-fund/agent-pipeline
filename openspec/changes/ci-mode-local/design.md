## Context

Today the pre-merge gate's "Step 1: CI" (`core/scripts/stages/pre_merge.ts`) polls `gh pr checks`, runs the zero-check-run recovery path (#281), and rebases on CI failure. The local test gate (`testgate.ts`, run via `runFormatAndTestGates`) already executes the repo's full CI command (`npm run ci` for this repo — see the `test-gate-ci-parity` capability) after every implement and fix step, inside the worktree, before pushing. For repos where GitHub Actions runs the *same* command, the remote run is a redundant re-proof that costs Actions minutes.

This change adds an opt-in `ci_mode: local` that substitutes the already-recorded local test-gate result for the remote `gh pr checks` poll, while keeping every other pre-merge gate (conflict, mergeability, OpenSpec validation) and the never-auto-merge floor intact.

## Goals / Non-Goals

**Goals**
- Let an operator opt a repo out of the redundant remote CI re-run when the local gate is authoritative.
- Preserve all existing `github`-mode behavior byte-for-byte (default unchanged).
- Fail closed: never advance with zero verification.

**Non-Goals**
- Auto-detecting whether Actions == the local gate (stays an explicit opt-in).
- Modifying branch-protection rules (operator responsibility when choosing `local`).
- Skipping the local test gate itself — it still runs after every implement/fix step in both modes.
- Adding any merge/deploy path — out of scope and structurally forbidden.

## Decisions

### 1. Config shape — a top-level scalar enum, mirroring `ci_no_run_grace_s`
`ci_mode` is a single top-level scalar (`z.enum(["github","local"]).optional()`), not a nested block, because it is a CI-gate posture knob in the same family as `ci_timeout`, `ci_poll_interval`, and `ci_no_run_grace_s`. The enum precedent is `eval_gate.mode` and `review_policy.ceiling_action`. `DEFAULT_CONFIG.ci_mode = "github"`; an absent key resolves to `"github"`. An out-of-enum value is rejected by Zod at parse time (consistent with the strict-validation contract in `pipeline-configuration`).

### 2. Not registered in `RIGOR_GATING_PATHS`
`ci_no_run_grace_s` — the closest existing CI-gate field — is deliberately **not** in `RIGOR_GATING_PATHS`; that list governs fields whose misconfiguration changes the pipeline's own *review coverage or paid LLM-call volume* (`review_policy.*`, `steps.*`, `eval_gate.*`, `shipcheck_gate.*`). `ci_mode` changes the *source* of CI verification (remote Actions vs. the authoritative local gate), not review/LLM coverage. Following the `ci_no_run_grace_s` precedent, `ci_mode` is a plain config key; its safety is enforced structurally by the fail-closed fallback (Decision 4), not by the validate command flagging it.

### 3. Data source — the test gate's existing `stage_accounting` event
The test gate already emits a `stage_accounting` event into the run's `events.jsonl` with `harness: "test-gate"` and `outcome: "success" | "failure"` (`testgate.ts` → `emitStageAccounting`). This is the "already recorded in the run store" signal the issue refers to — no new write path is added. The local-mode check reads `events.jsonl` from `opts.runDir` (production threads it via `pipeline-run.ts` → `advancePolling` → `advance`), selects events with `harness === "test-gate"`, takes the **most recent**, and inspects its `outcome`.

"Most recent" is the correct semantics: the gate runs the command on the initial run and after each fix attempt, and `runFormatAndTestGates` loops to convergence; the final recorded outcome for the run reflects the pushed state. A failure recorded earlier (then fixed) is superseded by a later success.

### 4. Fail-closed fallback — the safety floor
Local mode is "substitute the authoritative local gate," **not** "skip CI." If `opts.runDir` is absent, no `test-gate` `stage_accounting` event exists for the run (the gate was disabled via `test_gate.enabled: false`, or auto-detected no command and skipped), or the event log can't be read, the gate calls `setBlocked(..., "needs-human")` with a message that names `ci_mode: local` and the missing local result, and returns `blocked`. It never advances. This is what keeps the change rigor-preserving (golden rule #3): a misconfigured `local` repo with no local verification fails closed instead of shipping unverified.

### 5. Scope — only Step 1 is replaced
`ci_mode: local` branches only at "Step 1: CI". The early conflict pre-check (Step 0.5), the post-CI mergeability re-fetch (Step 2, incl. the BEHIND auto-rebase), and the OpenSpec-validation gate (Step 2.5) are independent of GitHub Actions and run unchanged in both modes. The review-SHA gate (#16) and OpenSpec archive (Step 0) also run unchanged. After the local check passes, control falls through to Step 2 exactly as the `github` path does after CI passes.

### 6. Default `github` is behavior-identical
When `cfg.ci_mode === "github"` the code path is unchanged; every existing `pre-merge-ci-gate` requirement (CI-failure block, zero-run recovery, close+reopen, rebase guard, grace window) continues to hold. The spec captures this by scoping those requirements to `github` mode in the new governing requirement rather than restating each one.

### 7. Testability seam
A `readRunEvents?` deps seam on `AdvancePreMergeDeps` (defaulting to `run-store.readEvents`) lets unit tests inject an in-memory event list — no real filesystem, git, or network — consistent with the existing DI pattern (`AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps`). `getPrChecks` is asserted **not called** in local-mode tests via a spy.

## Risks / Trade-offs

- **Resume-at-pre-merge in a fresh dispatch.** Each dispatch creates a new run directory. A dispatch that resumes directly at `pipeline:pre-merge` (e.g. a human re-run after unblocking) has no `test-gate` event in *its* run dir, so `ci_mode: local` fails closed and blocks with a clear message. This is the safe failure mode; the operator can re-run from `implementing` (which re-runs the local gate into the new run dir) or temporarily use `ci_mode: github`. The common case — a single dispatch's advance loop carrying planning/fix and pre-merge in the same process and run dir — is unaffected. Documented in the block message and README.
- **Operator misuse on a non-parity repo.** A repo whose Actions runs steps the local gate doesn't (matrix builds, environment-specific steps) would lose that coverage under `local`. Mitigated by: default `github`, explicit opt-in, and README guidance pointing at the `test-gate-ci-parity` requirement that the local command must match full CI before enabling `local`.

## Migration

None. The key is additive and defaults to current behavior; repos that never set `ci_mode` are unaffected.
