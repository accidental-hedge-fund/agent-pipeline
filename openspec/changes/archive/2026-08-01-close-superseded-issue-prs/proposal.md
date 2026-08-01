## Why

When advance creates a **new** managed branch + PR for an issue that already has another open
PR on a **different head** (earlier manual branch, abandoned pipeline slug, re-plan after a
capacity false-block), the old PR stays **OPEN** and often becomes **CONFLICTING** after later
merges. Operators must notice and close it by hand. Observed on **#601**: open PR **#656**
(`eval/expanded-corpus-20260728`) coexisted with pipeline PR **#726** (`pipeline/601-…`);
#726 shipped and closed the issue while #656 stayed open until explicitly closed as
superseded. Exact-head reuse correctly keeps one PR per managed branch, but does not clean up
**other** open PRs for the same issue.

## What Changes

- After advance creates **or reuses** the PR for issue N on the current managed head branch,
  the engine SHALL list other open PRs authoritatively associated with N whose head is **not**
  that managed branch, and dispose them.
- Default disposition is **close** with a structured supersession comment naming the
  superseding PR number and a stable reason marker (`pipeline-superseded`).
- Optional config mode `supersede_mode: comment-only` posts the same structured notice and
  leaves the old PR open (no close).
- Association uses the existing dual strategies from `pr-resolution` / `listOpenPrsForIssue`
  (same-repo `pipeline/<N>-*` head prefix, or target-repo `closingIssuesReferences` for N) —
  **not** title/body text search (see design Decision on issue-AC wording vs living
  `pr-resolution`).
- Never force-close PRs that are not associated with N, that are the current managed head’s
  PR, or that intentionally target a different base than `cfg.base_branch`.
- No change to exact-head reuse, no auto-merge, no history rewrite on superseded branches.

## Acceptance criteria

- [ ] When advance creates a new PR for issue N on managed head H, every other open PR
      associated with N (dual strategies) whose head is not H is disposed under the active
      supersede mode (default: closed with a `pipeline-superseded` comment naming the new PR).
- [ ] When advance reuses an existing PR on managed head H, the same disposal still runs for
      other open associated PRs (stale heads are not left open solely because H’s PR already
      existed).
- [ ] Exact-head reuse is unchanged: a second create is not attempted when an open same-repo
      PR already exists for branch H.
- [ ] Unrelated open PRs (no dual-strategy association to N) are never closed or
      supersede-commented by this path.
- [ ] Open associated PRs that target a base other than `cfg.base_branch` are left alone
      (not force-closed).
- [ ] Config `supersede_mode: comment-only` posts the structured notice and leaves superseded
      PRs open; default mode closes them.
- [ ] Unit tests (injected seams, no live network/git/subprocess): fixture with two open PRs
      for N on different heads → after ensure-PR for managed head, only the managed PR remains
      open under default mode; comment-only mode asserted separately; prove the test bites
      without the close/comment step.
- [ ] OpenSpec change validates; living requirements describe supersede-after-ensure-PR
      behavior after archive.

## Capabilities

### New Capabilities

- `supersede-issue-prs`: After managed PR create/reuse for issue N, identify other open
  associated PRs (dual strategies, non-matching head, same base) and close them with a
  structured `pipeline-superseded` comment, or post comment-only when configured.

### Modified Capabilities

- `implementing-resume`: Post-implementation ensure-PR path (create-or-reuse on exact head)
  SHALL invoke supersede disposal for other open associated PRs before treating ensure-PR as
  complete for the `implementing → review-1` transition.

## Impact

- **Code (implementation phase, not this step):** primarily
  `core/scripts/stages/planning.ts` (`resumeFromImplementing` after create/reuse PR), a pure
  supersede helper (likely near `gh.ts` resolution helpers or a small stage helper), optional
  config key in `config.ts` / pipeline.yml schema, injectable deps on the resume path.
- **Existing primitives to reuse:** `listOpenPrsForIssue` / `resolveOpenPrsForIssue`,
  `getPrForBranch`, `createPr`, `closePr`, `postPrComment` (or close-with-comment).
- **Tests:** new/extended unit tests with injected PR list + close/comment fakes; prove bite
  without disposal step.
- **Operators:** fewer orphan CONFLICTING PRs after re-plan / slug change / manual-then-pipeline
  PR pairs; audit trail via structured supersession comments.
- **Out of scope:** changing exact-head reuse; auto-merge; force-push or branch deletion on
  superseded heads; FRG pack auto-close (#754) semantics (different lifecycle moment); body/title
  text matching for association.
