## 1. Selection helper and config

- [x] 1.1 Add a pure selection helper (e.g. `selectSupersededOpenPrs`) that, given open
      PR candidates, issue N, managed head H, managed PR M, target repo, and base branch,
      returns the PR numbers to supersede under dual-strategy association, excluding M,
      excluding non-H matches only when head === H, excluding dual-strategy non-matches,
      and excluding different-base candidates.
- [x] 1.2 Confirm or extend the open-candidate shape / list path so base ref is available
      for the same-base filter (verify live `gh`/GraphQL field names before coding against
      them); keep dual-strategy association aligned with `resolveOpenPrsForIssue` (no
      title/body search).
- [x] 1.3 Add config support for `supersede_mode`: `close` (default when absent) and
      `comment-only`, matching existing `config.ts` / pipeline.yml schema patterns.

## 2. Dispose path and implement hook

- [x] 2.1 Implement async dispose helper with injectable deps (`listOpenPrsForIssue` or
      candidate inject, `closePr` and/or `postPrComment`) that posts a structured comment
      including marker `pipeline-superseded` and the superseding PR number, then closes
      under `close` mode or leaves open under `comment-only`.
- [x] 2.2 Fail-soft per PR and on list failure: log diagnostics; do not fail managed PR
      ensure solely because supersede failed.
- [x] 2.3 Hook dispose into `resumeFromImplementing` after create-or-reuse yields managed
      PR M for head H (both new and reused paths); do not change exact-head reuse or
      create-once race re-lookup.
- [x] 2.4 Ensure comment/close never targets M itself, never merges, and never force-pushes
      or deletes superseded branches.

## 3. Unit tests (injected seams only)

- [x] 3.1 Fixture: two open associated PRs for N on different heads, same base → after
      ensure-PR for managed head under default `close`, only the managed PR remains open
      among associated same-base PRs; structured comment/close invoked for the stale PR.
- [x] 3.2 Prove bite: same fixture without dispose (or with dispose no-op) leaves both
      open / does not call close — assertion fails if disposal is skipped in production path.
- [x] 3.3 Comment-only mode: stale PR receives `pipeline-superseded` comment naming
      superseding PR and remains open.
- [x] 3.4 Unrelated PR (no dual-strategy association) and different-base associated PR are
      not closed or supersede-commented.
- [x] 3.5 Reuse path (existing managed PR on H) still disposes other-head associated PRs.
- [x] 3.6 Fail-soft: close failure on one candidate does not fail the ensure-PR outcome;
      other candidates still attempted.
- [x] 3.7 Concurrent managed heads (injected race): two different `pipeline/<N>-*` PRs
      cannot mutually close each other; only the highest-number canonical survives open;
      non-canonical resume does not stage-transition.
- [x] 3.8 Absent managed PR on authoritative open list (externally closed) while a linked
      sibling remains open: no close/comment dispose and resume does not stage-transition.

## 4. Mirror, validate, gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated
      `plugin/` in the same commit.
- [x] 4.2 Run `openspec validate close-superseded-issue-prs` (and keep deltas archive-ready).
- [x] 4.3 Run `npm run ci` from repo root; fix failures before done.
