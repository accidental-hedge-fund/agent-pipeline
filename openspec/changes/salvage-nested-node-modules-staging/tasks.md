## 1. Depth-agnostic node_modules exclusion in the salvage staging command

- [ ] 1.1 In `core/scripts/salvage-harness-work.ts`, introduce a single canonical exclusion constant
      (e.g. `SALVAGE_NODE_MODULES_EXCLUDE = [":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**"]`)
      and use it to build `SALVAGE_GIT_ADD_ARGS`, replacing the top-level-only `:(exclude)node_modules`.
- [ ] 1.2 Update the scoped-add branch (currently `["add", "-A", "--", ":(exclude)node_modules", scope]`)
      to use the same depth-agnostic exclusion constant plus the `scope` pathspec.
- [ ] 1.3 Confirm no other call site hardcodes `:(exclude)node_modules` for salvage staging
      (`git grep ":(exclude)node_modules"`); update any that do.

## 2. Capture and surface the salvage failure reason

- [ ] 2.1 In `trySalvageUncommittedWork`, in addition to logging, capture the caught error message and
      return it to the caller (extend the return shape, e.g. `{ salvaged: boolean; failureReason?: string }`,
      keeping the existing non-throwing/total behavior — a salvage failure still never worsens the run).
- [ ] 2.2 Thread the captured `failureReason` into the no-commit blocker comment at each block site that
      runs a salvage pre-pass: `core/scripts/stages/planning.ts` (implement + OpenSpec authoring),
      `core/scripts/stages/fix.ts` (fix rounds), and the loop callers in `core/scripts/testgate.ts`
      (and `stages/eval.ts` / `stages/visual.ts` if they surface a no-commit block). When no salvage was
      attempted, the worktree was clean, or salvage succeeded, leave the blocker comment unchanged.
- [ ] 2.3 Keep `salvageIfNoNewCommit`'s signature/behavior compatible; only propagate the failure reason
      where a block is about to be posted.

## 3. Tests (prove they bite)

- [ ] 3.1 `core/scripts/salvage-harness-work.test.ts`: nested-`node_modules` dirty worktree → salvage stages
      the real file, `gitAddAll` args contain the depth-agnostic exclusion, and no `node_modules` path is
      committed. Prove it bites: narrowing the exclusion to `:(exclude)node_modules` makes the assertion fail.
- [ ] 3.2 `core/scripts/salvage-harness-work.test.ts`: `gitAddAll` throws → `trySalvageUncommittedWork`
      returns `{ salvaged: false, failureReason: <message> }` (does not throw).
- [ ] 3.3 Blocker-disclosure test at a block site (planning/fix/testgate as appropriate): a salvage
      failure reason is threaded into the block reason passed to the blocker sink; the clean/no-attempt
      case passes the unchanged reason. Prove it bites.
- [ ] 3.4 Confirm the existing scoped (`openspec/`) salvage tests still pass with the updated exclusion.

## 4. Mirror + CI

- [ ] 4.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 4.2 `npm run ci` passes green from the repo root (core tests, mirror check, install smoke,
      `openspec validate --all`).
