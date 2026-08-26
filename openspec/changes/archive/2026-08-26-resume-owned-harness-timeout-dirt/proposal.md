## Why

A timed-out or killed product-mutating harness can leave pipeline-owned uncommitted product changes in the managed worktree. A later launcher invocation resumes the stage, then a dirt-trust gate (today: format-gate pre-flight on implementing-resume) treats those leftovers as unknown operator dirt and blocks without running the implementer. That is a resumability deadlock: the format gate is correctly fail-closed for unknown dirt, but timeout recovery does not persist mutation ownership, so the retry cannot tell harness leftovers from unrelated edits.

This is engine dogfood, not a format-gate mole. **Class:** interrupted harness mutation ownership is not durable, so every porcelain dirt-trust gate fail-closes on pipeline-owned leftovers. **Site (dogfood):** lyric-utils `#758` on engine `v1.39.12` / profile `opencode` — implement harness committed `98c966a`, then timed out after 2405s with 12 modified product files; retry of `/pipeline 758` resumed `implementing`, ran no implementer, and blocked in four seconds with `Format gate blocked: pre-existing uncommitted changes`. The original timeout was classified `workflow-engine-defect`. The operator workaround (inspect, commit, unblock, retry) is false-human work.

## What Changes

- Persist a durable harness mutation-ownership record around every product-mutating harness invocation (implement, fix-round, test-fix, pre-merge auto-fix): pre-harness HEAD + porcelain, in-flight identity, and post-harness porcelain when the process is still alive. Ownership MUST survive process exit and a new launcher.
- Classify worktree porcelain with a shared helper into engine scratch, **pipeline-owned harness leftovers**, and **unknown product dirt**. Owned leftovers are the porcelain delta versus the durable pre-harness snapshot while the attempt is interrupted (timeout, crash, dead holder) and no live process owns the stage.
- Dirt-trust gates (format-gate pre-flight, test-gate dirty trust, implementing-resume completeness) SHALL consult that classifier. Unknown product dirt still blocks before auto-format can sweep it. Owned leftovers SHALL NOT be treated as unknown pre-existing dirt.
- On retry after an interrupted implement attempt with owned leftovers, the engine SHALL checkpoint those owned paths (salvage-equivalent, owned paths only) and SHALL NOT skip the implementer solely because commits exist ahead of base. Completeness still uses the shared implement-deliverable contract after checkpoint.
- Add a deterministic recovery recipe (`checkpoint_owned_harness_dirt`) on the engine-owned path, ordered before format-gate unknown-dirt block and before `repair_pipeline_item`. No LLM as first recoverer. No needs-human solely for owned leftovers.
- Terminal evidence SHALL name the disposition: recovered, checkpointed, resumed, or rejected (unknown dirt).
- A porcelain-dirt-site drift guard SHALL fail if a new dirt-trust `setBlocked` site ignores ownership classification. The next identical timeout-then-retry at another stage MUST hit the same classifier/recipe, not a new mole issue.

## Capabilities

### New Capabilities

- `harness-mutation-ownership`: Durable pre/post mutation ownership for product-mutating harness attempts; shared leftover-vs-unknown-dirt classification; cross-process hydration; checkpoint of owned leftovers; terminal evidence of recover vs reject.

### Modified Capabilities

- `harness-format-lint-gate`: Unknown pre-existing product dirt still blocks auto-fix. Pipeline-owned harness leftovers SHALL NOT satisfy that unknown-dirt guard. The gate SHALL NOT auto-format owned leftovers into a `chore: auto-format` commit as a substitute for ownership recovery.
- `implementing-resume`: Commits ahead of base SHALL NOT skip the implementer or jump to format/test when durable ownership shows an interrupted incomplete implement attempt with owned leftovers.
- `harness-uncommitted-salvage`: Checkpoint/salvage SHALL cover owned leftovers after an intermediate commit (not only `headAfter === headBefore`) and after a new process re-entry, scoped to owned paths.
- `test-gate-non-product-dirty`: Dirty-trust SHALL treat owned leftovers as owned, not as unknown product dirt. Unknown product dirt still hard-blocks.
- `autonomous-recovery-controller`: Default engine-owned recipe sequence SHALL include `checkpoint_owned_harness_dirt` before `repair_pipeline_item` when owned-leftover evidence is current. Successful checkpoint SHALL NOT mint a human hold.
- `engine-scratch-recover`: Porcelain dirt-site inventory/drift guard SHALL require ownership classification at dirt-trust sites (owned leftovers are not scratch; product unknown dirt stays fail-closed). Residual owned-leftover blocks SHALL use `harness-failure` → `workflow-engine-defect`, never `needs-human`.

## Acceptance criteria

- [ ] Replay of lyric-utils `#758` class: implement harness edits product files, may create an intermediate commit, then times out; a new `/pipeline N` (or equivalent single/loop re-entry) does not immediately block on those leftovers as unknown format-gate dirt; the retry checkpoints or resumes without an operator commit.
- [ ] Timeout with no intermediate commit and uncommitted product edits recovers the same way.
- [ ] Unrelated pre-existing product dirt (paths not in the ownership delta, or no durable ownership record) still blocks before auto-format runs and is not swept into a pipeline commit.
- [ ] Ownership hydrates after process exit and a fresh launcher; in-memory-only state is not sufficient.
- [ ] Implementing-resume does not skip the implementer solely because the worktree has commits ahead of base when ownership says the last implement attempt is interrupted-incomplete.
- [ ] Terminal evidence identifies whether leftovers were recovered, checkpointed, resumed, or rejected as unknown dirt.
- [ ] The next identical timeout-then-retry at another product-mutating stage (fix, test-fix, pre-merge auto-fix) uses the same classifier/recipe/gate contract; a path-local format-gate skip is not the shipped law.
- [ ] Unit tests inject deps (no real network, git, or subprocess) for: timeout after product edits; timeout after intermediate commit plus later edits; retry recovery; unrelated-dirt refusal; missing-ownership fail-closed.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate resume-owned-harness-timeout-dirt` and `npm run ci` pass.

## Impact

- New ownership module (run-store durable record + classifier) consumed by format-gate, test-gate dirty trust, salvage, implementing-resume, and recovery execution.
- `core/scripts/stages/format-gate.ts` pre-flight consults ownership; does not auto-format owned leftovers.
- `core/scripts/stages/planning.ts` `dispatchResume` / `resumeFromImplementing` completeness vs interrupted implement.
- Salvage helper staging scope for owned paths; timeout path after intermediate commit.
- Recovery policy / `realExecuteRecovery`: `checkpoint_owned_harness_dirt` recipe.
- `core/scripts/worktree-dirt.ts` and `porcelain-dirt-sites` inventory/drift guard.
- Tests under `core/test/` with injectable deps.
- Generated `plugin/` mirror after any `core/` edit.
- No merge-stage, no `auto_merge`, no weakening of unknown-dirt fail-closed, no treating product files as engine scratch.
