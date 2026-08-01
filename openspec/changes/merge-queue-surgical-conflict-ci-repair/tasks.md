## 1. Contracts and pure helpers

- [ ] 1.1 Define the hold reason enum/type (`merge-conflict`, `checks-failed`) and hold record shape (PR, issue, reason, summary, head SHA, attempts, remediation).
- [ ] 1.2 Implement pure `createHold` / `buildHoldRemediation` (or equivalent) with operator-visible remediation text for both reasons.
- [ ] 1.3 Implement pure `classifyEligibility` (or equivalent): dirty/conflict → `merge-conflict`; blocking checks → `checks-failed`; conflict wins when both.
- [ ] 1.4 Implement pure repair budget helpers (`createRepairBudget`, `canAttemptRepair`) with max attempts and optional wall-clock deadline.
- [ ] 1.5 Implement pure surgical repair prompt builder constrained to conflict/CI-only minimal diff (surgical-fix discipline).

## 2. Drive orchestration: hold, continue, re-gate

- [ ] 2.1 On revalidation or `mergePr` refusal classifiable as conflict/checks, record a typed hold and continue remaining candidates (no force-merge).
- [ ] 2.2 Wire hold records into the apply/drive result summary consumed by release-when-complete completeness.
- [ ] 2.3 After any candidate-moving repair, re-run the same eligibility gates (open/R2D, mergeable/CLEAN, checks green) before merge retry.
- [ ] 2.4 Call `mergePr` only when re-gate reports eligible; never merge while checks are red or merge state is dirty/conflicting.

## 3. Optional repair path (deterministic-first + shared mechanical)

- [ ] 3.1 Add repair opt-in (CLI flag such as `--repair` and/or config default false); dry-run never repairs.
- [ ] 3.2 Implement deterministic-first remediation (clean rebase/restack for conflict; check re-query / pre-merge CI helper reuse for checks) before implementer repair.
- [ ] 3.3 Claim and charge repair budget before implementer/mechanical side effects; map to shared `repair_pipeline_item` / mechanical-remediation seam (no merge-queue-only recovery taxonomy).
- [ ] 3.4 Resolve or rematerialize the managed worktree for the PR/issue; constrain edits to that worktree root.
- [ ] 3.5 On budget exhaustion, leave typed held/manual-repair outcome with evidence; do not emit human-authority solely for mechanical exhaustion; do not auto-merge.

## 4. CLI, registry, and isolation

- [ ] 4.1 Allowlist apply/repair-related flags on the `merge-queue` command registry entry as needed; reject unsupported flags fail-closed.
- [ ] 4.2 Ensure advance/dispatch paths still do not import or call merge-queue drive/hold/repair for merging.
- [ ] 4.3 Confirm no `auto_merge` config key is introduced.

## 5. Unit tests

- [ ] 5.1 Conflict snapshot → `merge-conflict` hold; zero merge calls when repair off.
- [ ] 5.2 Blocking checks → `checks-failed` hold; no merge while red.
- [ ] 5.3 Hold item A, continue to B/C (continue policy).
- [ ] 5.4 Successful repair stub → re-eligible → single `mergePr` call.
- [ ] 5.5 Budget exhaust → held with evidence; no further implementer claim; no force-merge.
- [ ] 5.6 Conflict wins when both conflict and checks fail.
- [ ] 5.7 Dry-run / repair-disabled paths perform zero repair side effects.
- [ ] 5.8 All of the above use injected deps only (no real network, git, or subprocess).

## 6. Mirror and CI

- [ ] 6.1 If `core/` changes, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [ ] 6.2 Run `npm run ci` from repo root and fix failures before marking the change done.
- [ ] 6.3 Run `openspec validate merge-queue-surgical-conflict-ci-repair` (and keep living-spec deltas valid).
