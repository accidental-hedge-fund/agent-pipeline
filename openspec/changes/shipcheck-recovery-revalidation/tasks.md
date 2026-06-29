## 1. Add the `head-drift` blocker kind

- [ ] 1.1 Add `"head-drift"` to `BLOCKER_KINDS` in `core/scripts/types.ts`.
- [ ] 1.2 Add a `head-drift` entry to `BLOCKER_RECIPES`: direct the operator to
  push the local commits so the PR head includes the fix (`git push`), remove the
  `blocked` label, then re-run `$pipeline {{N}}` — NOT a bare `--unblock`.
- [ ] 1.3 Map `head-drift → "merge-conflict-or-branch-drift"` in
  `blockerKindToInterventionKind` (`core/scripts/intervention.ts`).
- [ ] 1.4 Confirm `blocked-recipes.test.ts` (snapshot/coverage) now exercises
  `head-drift` and passes.

## 2. shipcheck-sha sentinel

- [ ] 2.1 In `core/scripts/stages/shipcheck.ts`, embed
  `<!-- shipcheck-sha: <full-sha> -->` (the evaluated PR head) into the verdict
  comment built by `formatShipcheckComment` (or appended where the comment is
  posted). The SHA is the 40-char PR head used for this evaluation.
- [ ] 2.2 Add a pure `extractShipcheckSha(commentBody): string | null` helper that
  reads the sentinel (mirror of `extractReviewedSha`), exported for tests.

## 3. Head-coherence gate in `shipcheck.advance`

- [ ] 3.1 Extend `ShipcheckDeps` with seams: `getPrDetail`, `getPrCommits`,
  `getGhActor`, and a worktree-head reader (`gitInWorktree` / a
  `getWorktreeHead(wtPath)`), all defaulting to the live `gh.ts`/`worktree.ts`
  implementations.
- [ ] 3.2 On the enabled path, BEFORE invoking the reviewer and before any
  transition to `ready-to-deploy`, run the gate after resolving `prNumber` + `wt`:
  - **3.2a Unpushed-fix block.** When `wt` exists, read local HEAD
    (`git rev-parse HEAD` in `wt.path`) and the PR head
    (`getPrDetail(cfg, prNumber).head_sha`). If they differ, `setBlocked(cfg, N,
    <reason naming both SHAs>, "shipcheck-gate", "head-drift")` and return a
    `blocked` outcome (`blockerKind: "head-drift"`). Skip this check when `wt` is
    null or no PR is linked.
  - **3.2b Post-verdict re-validation routing.** Read the most recent shipcheck
    verdict comment authored by `getGhActor()`; extract its `shipcheck-sha`. If
    present and `!== prHead`, fetch `getPrCommits` and classify the commits between
    the recorded SHA and HEAD. If at least one is NOT `isPipelineInternalCommit`,
    post a notice naming the stale + current head SHAs and
    `transition(cfg, N, "shipcheck-gate", "pre-merge", <reason>)`; return the
    advancing outcome. Otherwise (no prior comment / SHA == head / internal-only)
    fall through to the reviewer.
- [ ] 3.3 Conservative failure handling: if the PR head or worktree head cannot be
  determined due to a `gh`/git error, do NOT advance — surface the error
  (block/`needs-human`) rather than blessing an unverified head.
- [ ] 3.4 Leave the disabled-shipcheck skip path and advisory/gate verdict routing
  otherwise unchanged.

## 4. Unit tests (`core/test/`)

- [ ] 4.1 worktree HEAD ≠ PR head → outcome is `blocked` with
  `blockerKind: "head-drift"`; no transition to `ready-to-deploy`.
- [ ] 4.2 prior `shipcheck-sha` ≠ PR head with a developer commit between → outcome
  transitions `shipcheck-gate → pre-merge`; NOT `ready-to-deploy`; notice posted.
- [ ] 4.3 prior `shipcheck-sha` == PR head → proceeds to the reviewer / normal
  advance (no route-back).
- [ ] 4.4 only pipeline-internal commits since prior `shipcheck-sha` → proceeds
  (no route-back) — convergence guard.
- [ ] 4.5 first entry (no prior shipcheck comment) → proceeds; the posted verdict
  comment contains `<!-- shipcheck-sha: <full-sha> -->`.
- [ ] 4.6 no worktree → worktree-head check skipped, no crash; no PR → both head
  checks skipped, no crash.
- [ ] 4.7 `blockerKindToInterventionKind("head-drift") === "merge-conflict-or-branch-drift"`.
- [ ] 4.8 Prove the tests bite: with the head-coherence gate removed, 4.1 and 4.2
  fail (the stage advances directly to `ready-to-deploy`); restore the gate.

## 5. Mirror + CI

- [ ] 5.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror; commit it in
  the same change.
- [ ] 5.2 `npm run ci` green end-to-end (core tests + `build.mjs --check` +
  install smoke + `openspec validate --all`).
- [ ] 5.3 `openspec validate shipcheck-recovery-revalidation` passes.
