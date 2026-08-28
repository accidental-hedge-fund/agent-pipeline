## Why

A product-mutating harness that **finishes its work** but overruns the stage timeout can leave a clean, pipeline-authored salvage/checkpoint commit on the managed issue branch with **no push and no PR**. Every engine recovery path then refuses the item: post-timeout `afterRound` parks because `ctx.salvaged` is false when ownership checkpoint already authored the commit (#1246); `park-release` treats a never-pushed branch as squash-merge unreachability; `recover-parked` fail-closes with `no linked open PR; keep park`. Observed on v1.39.13 driving `pipeline train --merge` over lyric-utils `#268`: implementing overran by five seconds (2405s vs 2400s), salvage commit `00d1d81` (`34 files, +1604/−59`) sat unpublished, and four unrelated issues lost the run. Manual recovery required six operator steps, including a raw mid-flight label edit. This is engine dogfood, not an implementing-timeout mole.

**Class vs site:** the class is *unpublished pipeline-authored stage commits after a pre-PR park*. The site is implementing timeout on `#268`. The next identical timeout at implement, fix, or another pre-PR stage with a salvage/checkpoint commit MUST hit the same classifier, recipe, and recover-parked gate — not a new mole issue.

## What Changes

- Treat a timeout (or equivalent harness failure) that leaves a **validated** salvage/checkpoint commit as engine-owned recoverable work, not as a terminal unrecovered park.
- Same-process timeout `afterRound` SHALL proceed to the existing post-implement publish path (format/test gates → push → create-or-find PR → `implementing → review-1`) when ownership checkpoint **or** legacy salvage produced a commit, the worktree is clean of unknown product dirt, and HEAD is on the managed issue branch. It SHALL NOT require `ctx.salvaged === true` from the legacy helper alone.
- Add a shared deterministic recipe `publish_unpublished_stage_commit` (classifier + executor) consumed by the same-process timeout path, autonomous recovery, and `recover-parked`. Publish only when the commit is on the managed issue branch and the worktree is clean. Do not force-push. Do not skip format/test gates.
- On successful push and PR creation, transition through engine-owned state to `pipeline:review-1` and clear the timeout park. Do not require `pipeline triage --force` or raw `gh issue edit` label writes.
- If publication fails, retain the worktree, park with recovery evidence, and let `recover-parked` retry publication. Do not mint `needs-human` solely for this class.
- `recover-parked` SHALL NOT fail-closed solely because no linked open PR exists when a publishable unpublished commit is present, or when the park is a pre-PR engine-defect (planning / plan-review / implementing before PR). Residual-review senior reflow still requires a live PR HEAD.
- Park-release / local-only classification SHALL treat a never-pushed managed branch with unpublished commits as **local-only** (hard retain), not as squash-merge unreachability (`cannot verify all commits are merged … use --force if work was squash-merged`). `--force` SHALL NOT be the recovery path for unpublished salvage.
- **BREAKING:** none for happy-path implementing that already publishes after a successful harness. Timed-out stages that previously parked unrecovered will now attempt publish-or-retry.

## Capabilities

### New Capabilities

- `unpublished-stage-commit-publish`: Shared classifier and publish recipe for a pipeline-authored salvage/checkpoint (or equivalent implement) commit that exists on the managed issue branch, has not been pushed, and has no linked open PR. Gates, no force-push, engine-owned `review-1` transition, retain-and-retry on failure.

### Modified Capabilities

- `harness-mutation-ownership`: A successful same-process ownership checkpoint that leaves a clean worktree and a satisfied implement deliverable SHALL be treated as recovered work eligible for post-implement publish, not as a terminal `harness-failure` park.
- `harness-uncommitted-salvage`: Ownership-checkpoint commits SHALL count as salvage-equivalent for the downstream verification/publish path that already applies to legacy salvage.
- `implementing-resume`: Same-process implementing timeout SHALL take the existing post-implementation path (gates → push → PR → `review-1`) when the publishable-unpublished classifier matches, instead of blocking solely because the harness timed out.
- `supervisor-recover-parked`: Deterministic recover SHALL include `publish_unpublished_stage_commit` **before** requiring a linked open PR. Missing PR is fail-closed only when there is no publishable unpublished commit and the park is residual-review (needs PR HEAD). Pre-PR engine-defect parks without a publishable commit SHALL re-enter advance rather than fail-closed on `no linked open PR`.
- `autonomous-recovery-controller`: Default engine-owned recipe sequence for this class SHALL list `publish_unpublished_stage_commit` after `checkpoint_owned_harness_dirt` and before `repair_pipeline_item`. LLM repair is not first recoverer. Success SHALL NOT mint a human hold.
- `worktree-per-run-removal`: Never-pushed managed-branch commits that are not reachable from `origin/<base>` SHALL classify as local-only (hard retain), not squash-merge unverifiable. Park-release wording SHALL NOT tell the operator to `--force` as if the work was squash-merged.

## Acceptance criteria

- [ ] Replay of lyric-utils `#268` class: implement harness times out after a salvage or ownership-checkpoint commit on `pipeline/<N>-*` with a clean worktree and no open PR. The engine pushes the branch, opens a PR with `Closes #<N>`, transitions `implementing → review-1` through engine-owned `transition()`, and does not leave the item parked solely for the timeout.
- [ ] Same-process timeout whose ownership checkpoint authored the salvage-equivalent commit proceeds to that publish path even when `ctx.salvaged` from the legacy helper is false.
- [ ] Format and test gates still run before push. A failing gate blocks at the gate with the established kind and does **not** open a PR or jump to `review-1`.
- [ ] Publish refuses when the worktree has unknown product dirt, when HEAD is not the managed issue branch, or when the commit is not pipeline-authored salvage/checkpoint/implement work. It does not force-push.
- [ ] If push or PR creation fails, the worktree is retained, the item stays parked with recovery evidence naming the publish failure, and a later `pipeline recover-parked <N>` retries publication instead of exiting `fail-closed` with `no linked open PR; keep park`.
- [ ] Successful publish does not require `pipeline triage`, raw `gh issue edit` label writes, or `--force` worktree remove.
- [ ] `recover-parked` on a pre-PR engine-defect park (for example plan-review harness-auth failure with no salvage commit) does not fail-closed solely on missing PR; it runs remaining deterministic recover and re-enters advance when that is the engine-owned path. Residual-review senior reflow still requires a live PR HEAD and still refuses HIGH/CRITICAL/security/authority auto-override.
- [ ] Park-release of a never-pushed managed branch with unpublished commits retains as **local-only**, not as squash-merge unreachability, and does not suggest `--force` because work was squash-merged.
- [ ] The next identical timeout-then-unpublished-commit at another product-mutating stage uses the same classifier/recipe/recover-parked gate; an implementing-only `afterRound` special case is not the shipped law.
- [ ] Unit tests inject deps (no real network, git, or subprocess) for: timeout after checkpoint commit, timeout after legacy salvage, dirty-tree refusal, non-managed-branch refusal, push/PR failure retain-and-retry, recover-parked pre-PR publish, recover-parked pre-PR engine-defect without commit, never-pushed park-release local-only class.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate publish-unpublished-timeout-commit` and `npm run ci` pass.

## Impact

- `core/scripts/harness-round.ts` / implementing `afterRound`: checkpointed clean timeout proceeds to post-implement, not `setBlocked` solely on `!ctx.salvaged`.
- Shared publish classifier + recipe executor (new module or next to salvage/ownership), claimed through `realExecuteRecovery` and `recover-parked` deterministic-first.
- `core/scripts/recover-parked.ts`: move the linked-open-PR requirement after deterministic publish / pre-PR recover.
- `core/scripts/worktree.ts` `checkLocalOnlyCommits` / park-release: never-pushed unpublished commits are local-only.
- Recovery policy order: unlink → checkpoint leftovers → publish unpublished → repair.
- Tests under `core/test/` with injectable deps.
- Generated `plugin/` mirror after any `core/` edit.
- Docs: recover-parked and park-release wording; no merge-stage, no `auto_merge`, no `triage --force` mid-flight flag, no timeout-cap change, no #1265 theming.
