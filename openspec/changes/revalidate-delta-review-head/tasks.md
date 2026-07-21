## 1. Establish the staleness predicate

- [ ] 1.1 In `core/scripts/stages/pre_merge.ts`, extract a single helper that answers "is
      `reviewedSha` still current for this PR?" using the existing `getPrCommitsFn` +
      `isPipelineInternalCommit` classification: current iff it equals the head, or every
      commit since it is pipeline-internal. Return an explicit tri-state
      (`current` / `superseded-by <sha>` / `unknown`) so callers can fail closed on `unknown`.
- [ ] 1.2 Unit-test the helper directly: head match; only archive commits since; a developer
      commit since; reviewed SHA absent from history (rebase/squash); commit-list read failure
      → `unknown`.

## 2. Re-validate before recording a delta verdict

- [ ] 2.1 Before formatting/posting the initial delta-review comment, re-read the PR head and
      apply the helper. On `current`, record exactly as today.
- [ ] 2.2 On `superseded`, post a superseded delta-review comment naming the reviewed SHA and
      the newer head, with no `pipeline-blocking-keys` marker and no head-claiming `commitSha`,
      and skip the `setBlocked` / auto-fix branch for that verdict.
- [ ] 2.3 On `unknown`, take the existing conservative re-review fall-through (do not record a
      blocking verdict against an unconfirmed SHA).
- [ ] 2.4 Apply the same re-validation to the post-auto-fix delta re-review recording path,
      preserving its existing approve-side head confirmation (PR-head read plus the live
      remote-ref disambiguation from #371).

## 3. Bounded re-review at the head

- [ ] 3.1 After a supersession, re-resolve the head, recompute the delta diff and OpenSpec
      context from the worktree, and re-run the delta review against the new head.
- [ ] 3.2 Bound the re-runs (small fixed constant, default one extra attempt per pre-merge
      entry); on exceeding the bound, take the conservative re-review path.
- [ ] 3.3 Confirm the re-runs do not touch the `max_adversarial_rounds` counter.

## 4. Gate: ignore stale recorded blockers

- [ ] 4.1 Gate the recorded-blocking-keys re-evaluation on the helper: a stale recorded verdict
      routes to a review of the head instead of `setBlocked`.
- [ ] 4.2 Verify the current-verdict paths (exact SHA match, pipeline-internal-only commits,
      unchanged diff hash) still block on unresolved keys — no #228/#229 regression.

## 5. Regression tests (`core/test/`)

- [ ] 5.1 Replay #427: recorded delta verdict at `6c8a163` with blocking key `0e760c00`, PR head
      `dba0c95` (a developer commit) → asserts a delta review runs against `dba0c95` and no
      block on `0e760c00`.
- [ ] 5.2 Replay #432: recorded delta verdict at `f02a973` with five blocking findings, PR head
      `625e304` → asserts a delta review runs against `625e304` and no block on the stale keys.
- [ ] 5.3 Control: verdict at the current head with un-overridden blocking keys → still blocks
      at `pipeline:pre-merge` with `needs-human`.
- [ ] 5.4 Control: only archive commits since the verdict → still blocks (internal-commit
      classification unchanged).
- [ ] 5.5 Race test: head moves during the delta review → superseded comment posted with no
      blocking-key marker, delta review re-run against the new head.
- [ ] 5.6 Bound test: head moves on every attempt → conservative fall-through, no loop, no block
      on a superseded verdict.
- [ ] 5.7 Prove each regression test bites: confirm 5.1, 5.2 and 5.5 fail against the
      pre-change implementation.

## 6. Ship

- [ ] 6.1 `cd core && npm test`.
- [ ] 6.2 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 6.3 `npm run ci` from the repo root — green.
