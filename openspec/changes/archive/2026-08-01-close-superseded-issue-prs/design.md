## Context

After implement (or resume at `implementing`), `resumeFromImplementing` runs
format/test/docs → push → **create-or-find PR** → transition to `review-1`.

PR ensure today:

1. `getPrForBranch(cfg, managedBranch)` — exact head match only.
2. If missing, `createPr` for that head; race re-lookup before blocking.

That correctly **reuses** the PR for the current managed slug and avoids mistaking
`pipeline/N-old-slug` for the current PR. It does **not** dispose other open PRs
that still close or pipeline-prefix issue N on different heads. Singleton
`getPrForIssue` returns one match and leaves the rest open (comment in
`resolvePrForIssue` already notes callers that must dispose every match should use
`resolveOpenPrsForIssue` / `listOpenPrsForIssue` — FRG pack close #754 already does
this at a **different** lifecycle point).

**Dogfood:** issue #601, stale open PR #656 vs pipeline PR #726; #726 merged, #656
stayed OPEN until manual close.

**Living constraints:**

| Constraint | Source |
|------------|--------|
| No body/title text search for issue↔PR association | `pr-resolution` (#76) |
| Dual strategies: `pipeline/<N>-*` same-repo head, or target-repo closing refs | `pr-resolution` |
| Exact-head create-or-reuse for managed branch | `planning.ts` / implement path |
| Pipeline never auto-merges | golden rule |
| Unit tests inject I/O; no real network/git/subprocess | CLAUDE.md / AGENTS.md |
| Fail-soft multi-PR close pattern exists | FRG pack close (#754) |

**Issue AC wording conflict:** acceptance criteria mention association via
“closing reference **and/or title/body issue ref**.” Living `pr-resolution`
forbids body/title matching because it produced false positives. This design
**resolves the conflict in favor of dual strategies only** (closing refs +
pipeline branch prefix). Title/body-only mentions without closing refs or a
`pipeline/<N>-` head are intentionally out of scope.

## Goals / Non-Goals

**Goals:**

1. After managed PR create **or** reuse for issue N, dispose other open PRs
   associated with N whose head is not the managed branch.
2. Default: **close** with a structured `pipeline-superseded` comment naming the
   superseding PR.
3. Opt-in `comment-only` mode for operators who want visibility without close.
4. Never close unrelated PRs, the managed head’s own PR, or PRs targeting a
   different base than `cfg.base_branch`.
5. Fail-soft per superseded PR so a single close/comment failure does not block
   the implement → review-1 advance.
6. Unit-test the selection + disposition logic with injected seams; prove tests bite.

**Non-Goals:**

- Changing exact-head reuse or `getPrForBranch` window semantics (except if a
  shared open-candidate fetch is reused for efficiency — optional).
- Auto-merging any PR; force-push or deleting superseded branches/worktrees.
- Body/title text association.
- Replacing FRG pack auto-close; that remains end-of-pack lifecycle.
- Closing issues (only PRs).
- Cross-repo / fork spoof handling beyond existing dual-strategy guards.

## Decisions

### Decision 1: Hook after create-or-reuse in `resumeFromImplementing`

**Choice:** Run supersede disposal once the managed PR number is known (whether
created this run or reused), before transition / success path completion.

**Why:** Single code path for both first implement and resume; covers “new head”
and “re-entered with existing managed PR while a stale PR remains open.”

**Alternatives rejected:**

| Alternative | Why not |
|-------------|---------|
| Only on `prIsNew` | Reuse path leaves stale PRs open when managed PR already exists |
| Separate CLI / manual step | Fails the operator story; same stranding continues |
| Only on planning re-slug | Misses non-slug head changes (manual branch → pipeline) |
| Pre-merge only | Too late; conflicted orphans confuse operators earlier |

### Decision 2: Association = dual strategies; exclude managed head

**Choice:** Candidate set = open PRs from `listOpenPrsForIssue` /
`resolveOpenPrsForIssue` (same dual strategies as `pr-resolution`). Supersede
targets are those whose `headRefName` is **not** the current managed branch and
whose PR number is **not** the managed PR. Fork branch-prefix spoof remains
excluded by existing guards; same-repo closing-ref matches remain eligible.

**Why:** Reuses proven association; avoids reintroducing body/title false
positives (#76). Matches “linked to N” intent for pipeline and closing-ref PRs
(including the #601 manual-style head when it has a closing reference).

**Issue AC note:** Prefer dual strategies over title/body search; document as
intentional conflict resolution (see Context).

### Decision 3: Same-base filter (`cfg.base_branch`)

**Choice:** Do not supersede an associated open PR whose **base** is not
`cfg.base_branch` (e.g. intentional stacked or release-side PR). Implementation
may extend the open-candidate shape with base ref when listing, or fetch PR
detail for the small superseded-candidate set — either is fine if tests cover it.

**Why:** AC #3: never force-close intentional different-base work.

### Decision 4: Modes — default close, optional comment-only

**Choice:** Config key (name bikeshed-safe): `supersede_mode` with values
`close` (default) and `comment-only`.

- **`close`:** post structured comment (or use `closePr` with comment) and close
  the PR. No merge. No branch delete.
- **`comment-only`:** post the same structured comment; leave PR open. Does **not**
  set `pipeline:blocked` / needs-human solely for the existence of a superseded
  open PR (issue asked for “blocking comment” only as the non-close alternative;
  a high-visibility PR comment is sufficient and avoids stranding advance).

**Why:** Default matches operator desire (at most one live integration PR).
Comment-only supports cautious repos without disabling discovery.

### Decision 5: Structured comment marker

**Choice:** Comment body MUST include a stable machine-visible marker
`pipeline-superseded` and MUST name the superseding PR number (and ideally issue
N and managed head). Example shape (exact prose free as long as marker + PR # are
present):

```text
pipeline-superseded: superseded by PR #<managed> for issue #<N>
(managed head: <branch>). Closing this PR as abandoned relative to the
current pipeline head.
```

**Why:** Auditable timeline; greppable; consistent with other pipeline markers.

### Decision 6: Fail-soft disposal; do not block advance

**Choice:** Per-PR close/comment failures are logged and collected; they do **not**
fail `resumeFromImplementing` or prevent `implementing → review-1` when the
managed PR is healthy. Lookup failure for the open associated set is also
fail-soft (log; continue with managed PR).

**Why:** Mirrors FRG pack multi-PR close. Supersede is hygiene; stranding review
on a failed `gh pr close` of an abandoned draft is worse than leaving one orphan
for a later run.

### Decision 7: Injectable pure selection + deps for I/O

**Choice:** Export a pure helper e.g.
`selectSupersededOpenPrs(candidates, { issueNumber, managedBranch, managedPrNumber, baseBranch, targetRepo })`
and a thin async `disposeSupersededIssuePrs(...)` with deps:
`listOpenPrsForIssue` (or inject candidates), `closePr` / `postPrComment`,
optional base-detail fetch. Unit tests inject fakes only.

**Why:** CLAUDE.md test seam conventions; prove bite without the dispose step by
asserting open set when dispose is no-op / not called.

### Decision 8: No history rewrite; no auto-merge

**Choice:** Explicit non-goals. Superseded head branches may remain remote; cleanup
is operator or future worktree-stale work, not this change.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Closing a human-owned WIP PR that still closes N | Only dual-strategy association + same base; operators can use comment-only; comment names superseding PR for reopen/audit |
| Body-only linked PRs left open | Intentional (pr-resolution); if product later needs “connected without closing,” use GraphQL connected events in a follow-up |
| `getPrForBranch` still -L 100 while listOpen uses full pagination | Out of scope unless reuse shared candidate fetch; supersede path uses complete listOpen enumeration |
| Close fails mid-batch | Fail-soft per PR; next advance re-lists open and retries |
| Race: human reopens stale PR | Next ensure-PR re-runs disposal |
| Double-comment on comment-only re-runs | Prefer close mode default; comment-only may re-comment — acceptable or dedupe by marker in a small follow-up if noisy |

## Migration Plan

1. Ship default `close` mode — no config required for hygiene win.
2. Document `supersede_mode: comment-only` in pipeline.yml / config schema docs.
3. Rollback: set `comment-only` or feature-disable if needed (if an explicit off
   switch is added during implement, default remains close; pure absence of key =
   close). Prefer not introducing a third `off` mode unless review demands it —
   comment-only already avoids force-close.

## Open Questions

- Exact config path nesting (`steps.supersede_mode` vs top-level) — implementer
  matches surrounding config style in `config.ts`.
- Whether to include non-`pipeline/` heads that only match via closing refs:
  **yes** under dual strategies (covers #601-class manual branches).
- Whether base-ref is already available on the GraphQL open-PR page without
  extra fan-out — verify live shape at implement time (golden rule: verify
  external shapes; never guess).
