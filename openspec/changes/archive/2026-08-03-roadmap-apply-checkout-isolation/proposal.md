## Why

`pipeline roadmap --apply` opens the docs roadmap PR by creating/switching a day-keyed
branch **on the operator’s `repoDir` checkout** (`openRoadmapPr` in
`core/scripts/roadmap/writeback.ts` calls `gitSwitchBranch(repoDir, …)`). A dirty or
in-progress main/feature checkout is branch-switched under the operator. Separately, every
roadmap PR commit message hardcodes fossil trailers from the original feature PR
(`Issue: #171` and `Pipeline-Run: 171/2026-06-17T04:37:16Z`), polluting audit history.
When a PR already exists for the day-keyed branch, the path early-returns without
refreshing content, so a re-run with a newer plan freezes stale `docs/roadmaps/*.md` on
that open PR. Flagged in the 2026-07-27 architectural review (roadmap/scoreboard/improve);
#171 is closed and no longer a legitimate trailer target.

## What Changes

- **Checkout isolation for roadmap PR writeback.** Roadmap docs PR create/update SHALL
  commit and push from a throwaway worktree (or equivalent isolated git surface) linked to
  the repo — never `git checkout` / `git switch` on the caller’s current branch in
  `repoDir`. The operator’s branch, index, and working tree remain unchanged after a
  successful or failed apply.
- **Honest commit metadata.** Roadmap docs commits SHALL stop hardcoding `#171` and the
  2026-06-17 run id. Trailers SHALL use the current issue number and pipeline run id when
  the invocation has them; when `roadmap` runs without issue/run context (the normal
  no-issue-number path), the commit message SHALL omit those trailers rather than invent
  fossil values.
- **Refresh open day-branch PRs when the plan differs.** When a PR already exists for the
  day-keyed roadmap branch and the newly rendered `docs/roadmaps/<repo>.md` differs from
  the content on that branch/PR head, writeback SHALL update the branch content (commit +
  push) instead of early-returning with stale docs. Identical content remains a no-op.
- **Regression tests** on the writeback deps seams: no branch-switch on `repoDir`; commit
  message shape has no fossil `#171`/fake run id; existing-PR path updates when content
  differs and no-ops when identical.
- **Mirror + CI gate.** After core edits, regenerate `plugin/`; `npm run ci` green.

## Acceptance Criteria

- [ ] Running `pipeline roadmap --apply` (or the unit path for `openRoadmapPr`) never
  switches, checks out, or otherwise mutates the current branch of the caller’s
  `repoDir` checkout — a deps-seam test proves `gitSwitchBranch(repoDir, …)` is not used
  for writeback (or the equivalent seam is never called with the operator checkout path).
- [ ] Roadmap docs commit + push for PR create/update occur only inside an isolated
  throwaway worktree (or bare-clone equivalent); the operator checkout’s `HEAD`, index,
  and working tree after the call match pre-call state when the call succeeds or fails
  mid-writeback (excluding unrelated concurrent operator edits).
- [ ] Roadmap docs commit messages no longer contain the hardcoded strings
  `Issue: #171` or `Pipeline-Run: 171/2026-06-17T04:37:16Z` (or any other paste-fossil
  constants from the original #171 feature PR).
- [ ] When the invocation supplies an issue number and/or pipeline run id, those values
  appear as valid `Issue:` / `Pipeline-Run:` trailers on the roadmap docs commit; when
  neither is available, those trailers are omitted (not faked).
- [ ] When a PR already exists for the day-keyed roadmap branch and the newly rendered
  roadmap docs content differs from the content on that branch head, writeback updates
  the branch (commit + push) and returns the existing PR URL — it does not leave stale
  content frozen on the open PR.
- [ ] When a PR already exists and the rendered content is identical to the branch head,
  writeback is a no-op for git (no new commit) and still returns the existing PR URL.
- [ ] Regression tests cover: (a) worktree isolation / no operator-checkout branch switch,
  (b) commit message shape (no fossils; trailers only when context exists), (c) existing-PR
  content refresh vs identical no-op. Tests use injectable deps only (no real network/git
  subprocess required for the assertions).
- [ ] `node scripts/build.mjs --check` reports the mirror in sync and `npm run ci` is green
  (core tests, mirror check, install smoke, openspec validate).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `backlog-roadmap-engine`: strengthen the `pr_docs` / roadmap.md PR requirement so
  writeback is checkout-isolated, refreshes an existing day-branch PR when local plan
  content differs, and uses non-fossil commit metadata.
- `commit-traceability-trailers`: clarify that automated roadmap docs commits follow the
  same trailer rules when issue/run context is present, and MUST NOT invent fossil Issue /
  Pipeline-Run values when that context is absent.

## Impact

- Code: `core/scripts/roadmap/writeback.ts` (`openRoadmapPr`, `WritebackDeps` seams for
  worktree create/remove and optional issue/run context); possibly thin helpers in
  `core/scripts/worktree.ts` or a local throwaway-worktree helper if reuse is cleaner than
  issue-scoped `createWorktree`. Call sites that build writeback deps
  (`core/scripts/roadmap/index.ts` and any real-deps wiring).
- Tests: `core/test/roadmap-writeback.test.ts` (replace the current
  “must call `gitSwitchBranch`” regression with isolation + refresh + message-shape
  coverage); extend index/wiring tests only if deps surface changes.
- Specs: delta under `backlog-roadmap-engine` and a small delta under
  `commit-traceability-trailers`.
- Mirror: regenerate `plugin/` via `node scripts/build.mjs` after core changes.
- Out of scope: roadmap scoring algorithm, hygiene/milestone apply logic, day-branch
  naming scheme redesign (keep day-keyed branch unless isolation forces a path-only change),
  autonomous merge of the roadmap PR (human still owns the merge button).
