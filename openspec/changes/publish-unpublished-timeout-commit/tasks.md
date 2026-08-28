## 1. Classifier and recipe identity

- [x] 1.1 Add a pure classifier for a publishable unpublished stage commit (managed issue branch, clean of unknown product dirt, commits ahead of base, no linked open PR, pipeline-authored salvage/checkpoint/implement tip) and verify unit tests cover: matching salvage tip, matching checkpoint tip, dirty unknown path refuses, unmarked operator tip refuses, existing open PR refuses.
- [x] 1.2 Define recipe id `publish_unpublished_stage_commit` next to existing recovery action ids and verify a locked-string test fails if the id is renamed without updating the policy and recover-parked call sites.

## 2. Same-process timeout fall-through

- [x] 2.1 Change implementing `afterRound` so a harness timeout with `ownershipCheckpointed` or legacy `salvaged`, clean unknown-dirt porcelain, and a satisfied implement deliverable proceeds to the existing post-implement sequence instead of `setBlocked` solely on `timed out after <N>s`. Verify a `#268`-class fixture (timeout + checkpoint commit + `salvaged === false`) reaches gates/push/PR/`review-1` and does not park.
- [x] 2.2 Keep the `!salvaged` timeout-block path when there is no checkpoint commit and no legacy salvage, and verify a timeout with a clean tree and no new commit still blocks as `harness-failure` without opening a PR.
- [x] 2.3 When the deliverable is unsatisfied after checkpoint, do not publish to `review-1`; verify the completeness / re-invoke path runs instead.
- [x] 2.4 When format or test gates fail on the post-timeout path, block with the established gate kind and verify no PR is created and the stage does not become `review-1`.

## 3. Publish executor

- [x] 3.1 Implement `publish_unpublished_stage_commit` as a thin executor over the existing post-implement helper (gates, currency-checked non-force push, create-or-find PR with closing reference, engine-owned `implementing → review-1` transition, clear timeout park). Verify it does not call `git push --force` / `--force-with-lease` and does not write labels through triage or raw issue-edit.
- [x] 3.2 On push or PR-creation failure, retain the worktree, park with recovery evidence naming the failure as `harness-failure`, and verify no `needs-human` / `human-decision-required` is minted solely for that failure.
- [x] 3.3 Wire the default recovery policy to `unlink_engine_scratch` then `checkpoint_owned_harness_dirt` then `publish_unpublished_stage_commit` then `repair_pipeline_item`, and verify a policy-order unit test fails if implementer repair is first for publishable unpublished-commit evidence.
- [x] 3.4 Execute the recipe from `realExecuteRecovery` when classifier evidence is current (single, loop, and train share the executor), and verify success does not mint a human hold.

## 4. recover-parked pre-PR path

- [x] 4.1 Move linked-open-PR lookup after deterministic recover. Verify a parked implementing issue with no PR and a publishable unpublished commit claims `publish_unpublished_stage_commit` and does not return `fail-closed` / `no linked open PR; keep park`.
- [x] 4.2 Verify a pre-PR plan-review engine-defect / environment-auth park with no salvage commit does not fail-closed on missing PR; it skips senior reflow and re-enters advance.
- [x] 4.3 Verify a residual-review park at a post-PR stage with no readable PR HEAD still fail-closes after deterministic recover and does not apply supervisor overrides.
- [x] 4.4 Verify successful publish from recover-parked reports `deterministic-cleared` or `recovered`, does not consume the senior fingerprint budget, and may re-enter same-issue advance at `review-1`.

## 5. Park-release never-pushed classification

- [x] 5.1 Change `checkLocalOnlyCommits` (or the park-release wrapper) so empty successful `ls-remote` plus unreachable-from-base is **local-only** when there is no bound merge-result proof and no linked merged PR. Verify a `#268`-shape fixture retains as local-only and the retain reason does not contain `cannot verify all commits are merged` or `use --force to proceed if work was squash-merged`.
- [x] 5.2 Verify proven squash-merge (bound proof or linked merged PR + absent remote head + unreachable commits) remains `unverifiable` and is not reclassified as local-only.
- [x] 5.3 Verify automatic park-release never passes `--force` to delete a worktree that holds unpublished local-only commits.

## 6. Drift guard and shared-stage coverage

- [x] 6.1 Add a timeout-park-site drift guard that fails if a same-process harness-timeout `setBlocked` site can fire while a publishable unpublished commit is present without consulting the classifier. Verify the guard fails on a synthetic unguarded site.
- [x] 6.2 Add an injected fixture for a pre-PR product-mutating timeout outside implementing (fix-round or equivalent) that matches the classifier, and verify it claims `publish_unpublished_stage_commit` rather than requiring an implementing-only branch.

## 7. Mirror, validate, CI

- [x] 7.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 7.2 Run `openspec validate publish-unpublished-timeout-commit` until clean, then `npm run ci` from the repo root, and verify both are green.
