## Why

Dogfood (v1.29.2 loop / post-#768 residual path) showed mechanical `needs-human` parks when the **managed worktree is missing**: OpenSpec archive on #626 blocked with “worktree not found on disk” while the PR tip still had an active change; residual re-entry autofix on #729 returned `error` in ~4s with almost no harness work — consistent with no worktree rather than product residual judgment. Park-release may delete trees deliberately; the engine already owns create/reclaim and can reconstruct from the reviewed PR head (`createWorktree` startPoint from `origin/<pipeline/N-…>` or open-PR head). Escalating to a human for “restore the worktree” is a factory defect when rematerialize is safe.

## What Changes

- **Rematerialize-before-require:** Before any pre-merge/fix path that **requires** a managed worktree (OpenSpec archive, pre-merge autofix including residual re-entry, fix rounds that write in-tree), if on-disk lookup (`getForIssue` / `getOnDiskForIssue`) finds **no** worktree, the pipeline SHALL attempt to rematerialize from the open PR head branch into the managed worktree root — not first-hop to vague `needs-human`.
- **Reuse create/reclaim safety:** Rematerialize SHALL go through (or share) the existing create path that starts from the remote branch tip or resolvable open-PR head and applies #622 reclaim safety. Dirty-path / local-only checks run only when an existing candidate path is present; rematerialize MUST NOT force-destroy unpushed local-only commits.
- **Success continues the stage:** When rematerialize succeeds, archive / autofix / fix continues without a worktree-missing park.
- **Typed failure, not silent skip:** When rematerialize fails (auth, branch missing, reclaim blocked by dirty foreign tree, capacity), the stage blocks with a **typed** reason (`worktree-missing` or `worktree-creation-failed`) and concrete recovery text — not a residual product `needs-human` park, and not a silent skip of archive when an active OpenSpec change remains on the tip.
- **Durable evidence:** Run events (`gate_result` or equivalent stage event) MUST record rematerialize attempt + result so dogfood can prove the path fired.
- **Recipe honesty:** Update the `worktree-missing` recovery recipe (and any related tests) so it does not claim “re-run never recreates” for call sites that now rematerialize; residual failure after rematerialize still points at actionable recovery.

## Capabilities

### New Capabilities

- `worktree-rematerialize`: Shared seam and call-site contract for detecting a missing managed worktree, rematerializing from the recoverable PR/branch head under reclaim safety, recording attempt evidence, and returning typed success/failure for stages that require an on-disk tree.

### Modified Capabilities

- `openspec-integration`: The archive fail-closed rule for “worktree missing while PR has active change” changes from immediate `needs-human` to rematerialize-first, then archive or typed rematerialize failure (never silent skip when active tip change remains).
- `pre-merge-fix-round`: Pre-merge autofix (including residual re-entry) MUST rematerialize a missing worktree before `attemptPreMergeAutoFix` / implementer work, rather than returning bare `error` from a null worktree.
- `blocked-recovery-recipes`: `worktree-missing` recipe text MUST stay accurate after automatic rematerialize is introduced on the scoped call sites (no false “re-run never recreates” claim where rematerialize runs).

## Impact

- **Code (implementation phase):** `core/scripts/worktree.ts` (or a thin wrapper over `createWorktree`), `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec`, autofix closure / residual re-entry), `core/scripts/stages/fix.ts` (write-in-tree rounds), possibly `types.ts` recipe strings; durable event append at call sites.
- **Tests:** Unit tests with injected seams (no real network/git/subprocess) for: missing worktree + active OpenSpec → rematerialize → archive proceeds; residual re-entry autofix rematerializes before autofix; rematerialize failure → typed block, no silent archive skip; #622 dirty/local-only reclaim safety not weakened.
- **Out of scope:** Full #759 attempt ledger / multi-mechanism marker retirement; expanding residual allowlist beyond #768 (`code-behind-spec`); product fixes for #675 merge findings; rematerialize for every stage that today blocks on missing worktree (eval/visual/design may remain as-is unless they share the same seam without expanding scope).
- **Related:** #760 (bounded retry / rematerialize class), #759 (longer-term reconcile), #768 (factory clear dumb escalations), #622 (worktree reclaim safety), park-release worktree deletion.

## Acceptance criteria

Observable, falsifiable outcomes that make #769 done:

- [ ] Missing managed worktree + active OpenSpec change on PR tip: rematerialize seam is invoked; on success archive proceeds without a worktree-not-found `needs-human` park (unit-tested with fakes).
- [ ] Missing managed worktree + residual re-entry autofix eligible: rematerialize runs before `attemptPreMergeAutoFix` (or autofix dep observes a recreated path); no immediate bare `error` solely from null worktree when rematerialize would succeed.
- [ ] Rematerialize failure: stage blocks with typed `worktree-missing` / `worktree-creation-failed` (or equivalent documented kinds) and concrete recovery text; active OpenSpec change is **not** silently skipped.
- [ ] Existing dirty / local-only reclaim safety (#622) is not weakened: rematerialize does not force-remove dirty or unpushed local-only candidates.
- [ ] Durable run events record rematerialize attempt + pass/fail (or skip) for dogfood proof.
- [ ] `worktree-missing` recipe / recipe tests remain truthful after the behavior change.
- [ ] Unit tests inject I/O via deps; `openspec validate` passes for this change; implementation phase will require `npm run ci` green and `plugin/` mirror regen if `core/` changes.
- [ ] Dogfood: re-advance #626 / #729 after install does not park solely for “worktree not found” when the PR branch remains recoverable.
