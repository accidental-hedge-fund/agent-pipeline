## 1. Config schema and defaults

- [ ] 1.1 Add a strict optional `auto_loop` block to `PartialConfigSchema` in `core/scripts/config.ts`: `enabled` (boolean), `max_rounds` (positive int), `max_wallclock_minutes` (positive int), `stages` (array of `STAGES` members), with field `.describe()` text for `pipeline config schema`.
- [ ] 1.2 Add `DEFAULT_CONFIG.auto_loop` (disabled: `enabled: false`, conservative `max_rounds` / `max_wallclock_minutes`, empty or conservative `stages`).
- [ ] 1.3 Add `Config.auto_loop` to `core/scripts/types.ts` and resolve `auto_loop` field-by-field in `resolveConfig()` (file over default).
- [ ] 1.4 Validate `stages` entries against `STAGES`; reject unknown stage names with a parse error naming the entry.
- [ ] 1.5 Add the documented `auto_loop` sample (disabled) to the generated `.github/pipeline.yml` template string in `config.ts`.

## 2. Recoverability classification

- [ ] 2.1 Add a pure helper that classifies a non-advancing stage outcome as recoverable (a `waiting` outcome, or a `blocked` outcome whose `BlockerKind` has a `BLOCKER_RECIPES` recovery recipe) vs. non-recoverable (`error`, `no-op`, `finalized`, recipe-less `blocked`).
- [ ] 2.2 Add a pure helper that decides eligibility: recoverable AND current stage ∈ `auto_loop.stages` AND `auto_loop.enabled`.

## 3. Budget governor

- [ ] 3.1 Introduce an injected clock seam (`deps.now()`) for wall-clock budgeting in the advance-loop path; thread it through the loop's deps.
- [ ] 3.2 Track rounds consumed and elapsed wall-clock; add a pure `budgetRemaining()` / `canContinue()` helper checking both `max_rounds` and `max_wallclock_minutes`.
- [ ] 3.3 Decrement the round budget by exactly one per automatic continuation.

## 4. Advance-loop integration

- [ ] 4.1 In the `MAX_ITERATIONS` loop body, on a non-advancing outcome: if `auto_loop` eligible AND `canContinue()`, perform the existing pipeline-owned recovery and continue; otherwise stop as today.
- [ ] 4.2 Treat `needs-human` (ceiling, `ceiling_action`, recurrence early-park) and the plan-review human-feedback gate (#23) as hard stops that ignore remaining budget.
- [ ] 4.3 Ensure no merge/deploy/publish surface is reachable from the continuation path and scope is never expanded (surgical-fix discipline preserved).
- [ ] 4.4 Keep `MAX_ITERATIONS`, `TERMINAL_STAGES`, and the never-auto-merge floor unchanged.

## 5. Recurrence integration (#133)

- [ ] 5.1 On the post-fix review round, when the review-loop-recurrence early-park fires, stop the auto-loop and do NOT re-spend budget on the recurring finding.
- [ ] 5.2 Confirm genuinely-new findings (new `findingKey`) may still consume remaining budget as new work.

## 6. Evidence recording and handoff

- [ ] 6.1 Write a continuation event (recoverable class/stage, rounds remaining, wall-clock remaining) to the evidence bundle via the existing recovery-event path; writes non-fatal.
- [ ] 6.2 Post/update a run-comment line per continuation stating why it continued and the budget remaining.
- [ ] 6.3 On budget exhaustion, transition to `needs-human` and post the evidence-backed handoff (attempted / remaining / budget consumed); no auto-advance; resumable via the existing `--override` path.

## 7. Tests

- [ ] 7.1 Config: valid `auto_loop` resolves; absent → disabled default; unknown sub-key, non-positive `max_rounds`, and unknown `stages` entry each throw (prove the test bites without the fix).
- [ ] 7.2 Default-unchanged regression: with `auto_loop` absent, the advance-loop trace is identical to pre-change for `waiting` and recoverable `blocked` outcomes.
- [ ] 7.3 Allowlist gating: recoverable stop at an allowlisted stage continues; at a non-allowlisted stage stops; non-recoverable outcome always stops.
- [ ] 7.4 Budget accounting: round decrement per continuation; round-exhaustion parks; wall-clock-exhaustion parks (fake clock).
- [ ] 7.5 Human checkpoints: `needs-human` and the plan-review gate hard-stop with budget remaining.
- [ ] 7.6 Recurrence: a recurring finding early-parks and does not re-spend budget; a new finding may continue.
- [ ] 7.7 Override/sandbox: continuation fix/review honors `review_policy` thresholds and `--override`; harness invocations honor `harness_sandbox`.
- [ ] 7.8 Evidence: continuation events and the exhaustion handoff are recorded; recording failure is non-fatal.

## 8. Mirror and gate

- [ ] 8.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror and commit it in the same change.
- [ ] 8.2 Run `npm run ci` from repo root; all checks green.
- [ ] 8.3 Run `openspec validate bounded-auto-loop` and fix every structural error.
