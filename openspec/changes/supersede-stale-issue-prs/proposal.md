## Why

When advance opens (or reuses) a managed PR for issue N, other open PRs for the same issue on **different heads** stay OPEN. After later merges they often go CONFLICTING and operators must close them by hand. Observed on #601: stale PR #656 (`eval/expanded-corpus-20260728`) coexisted with pipeline PR #726 (`pipeline/601-…`); #726 merged and closed the issue while #656 stayed open until an explicit close.

Exact-head reuse (`getPrForBranch`) correctly reuses the PR for the current managed branch. It does **not** clean up other open issue-linked PRs. Operators need at most one live integration PR per issue.

## What Changes

- After the post-implement create-or-reuse of the managed-head PR for issue N, the engine **lists** open same-repo PRs that are issue-linked to N under the same dual strategies as PR resolution (branch-prefix `pipeline/<N>-` and target-repo `closingIssuesReferences`) whose head is **not** the current managed branch.
- For each such PR, the engine either:
  - **closes** it with a structured comment naming the superseding PR and reason (`pipeline-superseded`) — **default**, or
  - posts a high-visibility comment and leaves it open when config sets `supersede_mode: comment-only`.
- Safety filters: never act on non-issue-linked PRs, fork/cross-repo spoof heads, or PRs targeting a different base than the managed integration base.
- Config: optional `supersede_mode: close | comment-only` (default `close`).
- Unit tests with injectable deps: two open issue-linked PRs on different heads → after managed-head create/reuse, only the managed PR remains open (or comment-only asserts comment + still open). Prove the test bites without the supersede step.

## Acceptance Criteria

Observable, falsifiable outcomes that make this issue done:

- [ ] Given issue N with open PR A on head `other-branch` (issue-linked via branch-prefix or target-repo closing reference) and managed head `pipeline/N-…` with no open PR yet, after post-implement create of the managed PR B, PR A is **closed** (default mode) and carries a comment that names PR B and the reason `pipeline-superseded`.
- [ ] Given the same fixture when the managed PR B already exists and is **reused** (exact-head match), the supersede step still runs and closes A — reuse alone does not leave A open.
- [ ] Given `supersede_mode: comment-only`, A remains open and receives a blocking/high-visibility comment naming B and `pipeline-superseded`; A is not closed.
- [ ] An open PR that is **not** issue-linked to N under dual strategy (body/title mention only, or wrong-repo closing ref) is **not** closed or comment-flagged by the supersede step.
- [ ] An open issue-linked PR whose base is **not** the managed integration base (`cfg.base_branch`) is **not** closed or comment-flagged.
- [ ] An open PR whose head **is** the current managed branch is never closed as superseded (self-match / exact-head reuse unchanged).
- [ ] Regression tests cover the multi-PR fixture and **fail** if the close/comment supersede step is removed or skipped after create/reuse.

## Capabilities

### New Capabilities

- `supersede-stale-issue-prs`: After managed PR create-or-reuse for issue N, list other open same-repo issue-linked PRs on different heads and close or comment-flag them as superseded under config mode and safety filters.

### Modified Capabilities

- `implementing-resume`: Post-implement create-or-reuse path SHALL invoke supersession after the live managed PR number is known (create and exact-head reuse).
- `pipeline-configuration`: Accept optional `supersede_mode` (`close` | `comment-only`, default `close`).

## Impact

- **Code:** primarily `core/scripts/stages/planning.ts` (`resumeFromImplementing` after create/reuse), likely a pure helper + `gh.ts` list/close/comment seams; optional config key in `config.ts` / schema.
- **Tests:** new unit tests with injectable deps (no real network/git); prove bite without the supersede action.
- **Operators:** fewer stale open PRs after re-plan / abandoned-slug / capacity false-block recovery; structured `pipeline-superseded` comments for auditability.
- **Out of scope:** changing exact-head reuse; auto-merge; rewriting or deleting the superseded branch; body-text-only issue linkage for close candidates (see design — safety alignment with living `pr-resolution`).
