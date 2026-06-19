## Why

The advance loop is intentionally conservative: it stops (`waiting`, recoverable `blocked`) and waits for a human re-invoke even when the failure is routine and recoverable — a flaky test rerun, a stale-branch rebase, a reviewer/shipcheck finding fix. These stops cost manual nudges without adding safety, because the recovery is already a pipeline-owned action. A *bounded* auto-loop can continue through additional fix/review/test/eval cycles within explicit budgets before parking, reducing manual nudges **without granting any new shipping authority**. This is the agent-pipeline-shaped version of SmallHarness's auto-loop (SmallHarness comparison, 2026-06-14): keep the useful bounded-autonomy pattern; do not turn the pipeline into an interactive terminal harness.

## What Changes

- Add an **opt-in** `auto_loop` config block (`enabled`, `max_rounds`, `max_wallclock_minutes`, `stages` allowlist). When absent or `enabled: false`, the advance loop behaves **byte-for-byte** as today.
- When enabled, recoverable non-advancing outcomes (`waiting`, recoverable `blocked`) at an **allowlisted** pipeline-owned stage convert from *stop* to *automatic continuation* — the loop performs the existing pipeline-owned recovery (rerun / rebase / fix) and continues, instead of parking for a human re-invoke.
- Each automatic continuation **records why it continued and what budget remains** (evidence bundle + a run comment).
- When the round or wall-clock budget is exhausted, the run **parks in `needs-human`** with a concise, evidence-backed handoff (what was attempted, what remains, budget consumed) — identical in authority to the existing ceiling park (no auto-advance).
- Auto-loop continuations are bounded by recurrence detection: a blocking finding that recurs after a fix (review-loop-recurrence, #133) triggers the existing early-park and the auto-loop **SHALL NOT** re-spend budget to retry it.
- Human checkpoints, override policy, and sandbox settings are hard constraints the budget cannot override: the loop never merges/deploys/publishes, never bypasses `needs-human` or the plan-review human-feedback gate (#23), never expands issue scope, and honors `review_policy` thresholds, `--override` dispositions, and `harness_sandbox`.

## Capabilities

### New Capabilities
- `bounded-auto-loop`: An opt-in mode that lets the advance loop automatically continue through recoverable, pipeline-owned recovery cycles within explicit round and wall-clock budgets, recording rationale per continuation, then park at `needs-human` with evidence on exhaustion — without granting any new shipping authority.

### Modified Capabilities
- `pipeline-configuration`: Accept an optional, strict `auto_loop` block in `.github/pipeline.yml`; default-disabled; validated and rejected on unknown sub-keys, like other feature blocks.

## Acceptance Criteria

- [ ] `.github/pipeline.yml` accepts an `auto_loop` block with `enabled` (bool), `max_rounds` (positive int), `max_wallclock_minutes` (positive int), and `stages` (array of known stage names); an unknown sub-key or wrong type fails `resolveConfig()` with a parse error naming the offending key.
- [ ] With `auto_loop` absent or `enabled: false`, the advance loop's transitions and stop outcomes are identical to pre-change behavior (a regression test diffs the loop trace).
- [ ] With `auto_loop.enabled: true`, a recoverable stop (`waiting` or recoverable `blocked`) at an **allowlisted** stage continues automatically (recovery + advance) instead of breaking; a recoverable stop at a **non-allowlisted** stage still breaks.
- [ ] The auto-loop never invokes any merge/deploy/publish path and never advances past a human checkpoint; `needs-human` (ceiling park or recurrence early-park) and the plan-review human-feedback gate (#23) stop the loop immediately regardless of remaining budget.
- [ ] Each automatic continuation writes a record (recoverable class, rounds remaining, wall-clock remaining) to the evidence bundle and posts/updates a run comment line stating why it continued and the budget remaining.
- [ ] When `max_rounds` or `max_wallclock_minutes` is exhausted, the run transitions to `needs-human` with a concise evidence-backed handoff (attempted, remaining, budget consumed) and does **not** auto-advance.
- [ ] A blocking finding that recurs after an auto-loop fix triggers the existing review-loop-recurrence early-park (#133); the auto-loop does not re-spend budget to retry a recurring finding, so the same finding cannot churn to the budget ceiling.
- [ ] Auto-loop fix rounds honor `review_policy` block thresholds and recorded `--override` dispositions, and auto-loop harness invocations honor `harness_sandbox`.
- [ ] New unit tests cover budget accounting, allowlist gating, recurrence integration, human-checkpoint hard stops, and default-unchanged behavior; `npm run ci` is green with the `plugin/` mirror regenerated.

## Impact

- `core/scripts/config.ts` — `PartialConfigSchema` gains a strict optional `auto_loop` block; `DEFAULT_CONFIG.auto_loop` (disabled); resolution + descriptions for `pipeline config schema`; the documented `.github/pipeline.yml` sample.
- `core/scripts/types.ts` — `Config.auto_loop` type; the auto-loop is *not* added to `STAGES` (no new stage) and does not touch `TERMINAL_STAGES` or the never-auto-merge floor.
- `core/scripts/pipeline.ts` — the advance loop (`MAX_ITERATIONS` body) gains a budget-governed continuation path on recoverable stop outcomes; a deterministic clock seam (`deps.now()`) for wall-clock budgeting so unit tests do no real time/I/O.
- Evidence bundle (`evidence-bundle`) gains auto-loop continuation records and the budget-exhaustion park reason; no schema-version break (recovery events already supported).
- `core/test/` — new unit tests for budget accounting, allowlist gating, recurrence integration, human-checkpoint hard stops, and default-unchanged behavior.
- No changes to review schema, state-machine edges, `TERMINAL_STAGES`, or the never-auto-merge structural guarantee. Repos that don't set `auto_loop` are unaffected.
