## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add an injected park-release / automatic-remove test: clean managed worktree, remote head absent, local-only reports squash-merge unreachability or `null`, **bound proof present** for issue N / PR P / configured base / proven `merge_result_oid`. Assert the worktree is **removed** and the result/reason does **not** contain `commit verification failed (git/network/auth error)` or "check connectivity". Verify this test **fails** against current code (today it retains with git/network/auth). No live network, git, or subprocess.
- [ ] 1.2 Add an injected case with the same post-squash-merge unreachability and **no** bound proof. Assert the worktree is **retained** and the reason names commits not reachable from the base (existing squash-merge / `--force` wording). Assert the reason does **not** contain `commit verification failed (git/network/auth error)`. Verify this test **fails** if the current `null` path still emits git/network/auth. Same I/O seam as 1.1.
- [ ] 1.3 Add injected cases: (a) bound proof + **dirty** tree → retain, reason names dirty, not git/network/auth, remove seam not called; (b) bound proof + clean tree + remove seam throws filesystem/cleanup error → retain with that error, not git/network/auth. Verify both fail if implementation force-discards dirty trees or maps cleanup failure to git/network/auth.
- [ ] 1.4 Add injected identity-mismatch cases: proof for a different issue, PR, base, or OID MUST NOT release this worktree. Verify the test **fails** if unmatched proof authorizes remove.
- [ ] 1.5 Add an injected classifier case: `ls-remote` succeeds with empty remote head, then reachability against `origin/<base>` is unreachable or the log command fails. Assert the tier is squash-merge unreachability, not git/network/auth. Verify it **fails** against current `checkLocalOnlyCommits` returning `null` on the failed `git log` after empty `ls-remote`.

## 2. Shared classifier and ladder

- [ ] 2.1 Change local-only verification so an observed missing remote head (successful empty `ls-remote` or equivalent) plus not-reachable-from-base is classified as squash-merge unreachability, not `null` / git/network/auth. Keep `null` only when the transport cannot tell whether the remote head exists. Verify tasks 1.2 and 1.5 pass. Do not treat a dirty tree as clean.
- [ ] 2.2 Extend the shared automatic-remove / `evaluateRemoveSafety` wrapper to accept bound merge-result proof `{ issue, pr, base, merge_result_oid }`. When proof matches and the tree is clean, squash-merge unreachability SHALL NOT retain. Do **not** set `force: true` to skip unverifiable. Verify task 1.1 passes and a dirty+proof case still retains (task 1.3a).
- [ ] 2.3 Thread bound proof through `removeManagedWorktreeSafely` and `releaseWorktreeForParkedIssue` (single safety evaluation per decision). Verify `core/test/worktree-remove-safety-registry.test.ts` still classifies both sites as ladder-backed. Verify task 1.3b (cleanup error) reports the remove-seam message.

## 3. Callers: deploy_ready, pipeline park, train --merge

- [ ] 3.1 Pass bound proof into `deploy_ready` automatic removal when the engine has proven `merge_result_oid` in `origin/<base>` for this issue and PR. Verify the injected deploy_ready / safe-remove path releases a clean tree and does **not** log `worktree retained after ready-to-deploy (commit verification failed (git/network/auth error); check connectivity and retry)`.
- [ ] 3.2 Pass the same bound proof into `maybeReleaseWorktreeOnPark` / `/pipeline` / `pipeline single` park-release. Verify an injected advance-finalize case matching 1.1 releases. Cleanup failure and dirty retain MUST NOT change `pipeline:ready-to-deploy`.
- [ ] 3.3 After `train --merge` records proven/integrated `merge_result_oid`, invoke the **shared** park-release gate with that identity. Do not add a train-only `git worktree remove`. Verify an injected train merge case matching 1.1 releases; dirty retain does not clear `integrated`. Verify a test fails if train deletes a worktree without going through the shared gate.

## 4. Docs, mirror, CI

- [ ] 4.1 Update operator-facing park-release / worktree docs so they distinguish: bound-proof release, squash-merge unreachability without proof (retain + existing `--force` wording), and true git/network/auth. Verify the docs mention `/pipeline` and `train --merge` share the gate, and that `/pipeline:cleanup` is not the required fix.
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [ ] 4.3 Run `openspec validate park-release-bound-merge-proof` and `npm run ci` from the repo root. Verify both are green. Do not merge inside advance/loop. Do not add `auto_merge`. Do not weaken review.
