## 1. Shared any-state lookup

- [x] 1.1 Extend the issue-timeline any-state picker to take issue N and match same-repo PRs via ConnectedEvent, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)`; keep fork exclusion; verify `core/test/gh-parsers.test.ts` covers all four identities plus mere-mention-null and fork-null.
- [x] 1.2 Add `title` (and issue N) to the any-state GraphQL PullRequest fragment if the title identity needs it; verify the injected GraphQL runner test asserts the query is issue-timeline GraphQL, not `gh pr list`, and includes the fields the picker reads.
- [x] 1.3 Keep open-path `getPrForIssue` on branch-prefix + `closingIssuesReferences` only; verify existing open-path tests still pass and a title-only `(#N)` open PR without those strategies still returns null.

## 2. observeTrain proof and ship coordinator

- [x] 2.1 Drive `observeTrain` through injectable gh/git (or an extracted merged+ancestor helper) so a three-issue fixture with `willCloseTarget: false`, merged same-repo pipeline PRs, and merge OIDs ancestors of `origin/main` returns complete train evidence with `integrated_head_oid`; verify the test fails on today's lookup.
- [x] 2.2 Same fixture: verify `convergeTrain` / ship coordinator does not invoke `runTrain` and does not STOP with `ready-to-deploy but has no linked open PR`.
- [x] 2.3 Verify ConnectedEvent / `willCloseTarget: true` still yields complete train evidence, and a fork-only timeline does not.
- [x] 2.4 After successful observation with no later phase done, verify coordinator `next_action` is `frg_pack` (or later post-train), not `train_merge` with `train: null`.

## 3. Train merge-wave inheritance

- [x] 3.1 Add a train `--merge` fixture: ready-to-deploy, no open PR, merged `(#N)` / `pipeline/<N>-*` PR contained in base → already-integrated, no merge mutation, no `ready-to-deploy but has no linked open PR` STOP; verify in `core/test/train.test.ts` with injected deps.

## 4. Mirror and CI

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 4.2 Run `npm run ci` from repo root and fix failures until green.
