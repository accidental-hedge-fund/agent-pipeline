## Why

`pipeline improve`'s auto-file path serializes dedup + rate-cap + issue creation under
`withLock` — a `/tmp` PID lock (`lock.ts`), the engine's standard concurrency primitive. That
lock is **host-local**: two pipeline processes for the same repository on *different machines*
can each acquire their own `/tmp` lock, observe the same empty GitHub snapshot, and both file
the same improve issue or overshoot the per-window rate cap. The lock guarantees nothing across
hosts.

This was deferred out of #421 (review finding `582c19e6`, conf 0.96, raised at the 3-round
ceiling). A full GitHub-native mutex applied uniformly to *every* lock site is a larger
architectural change than #459's scope; the single-operator factory (v1.15.0) does not need it
engine-wide. What #459 fixes is the one site whose cross-host failure is user-visible and
irreversible — an auto-filed GitHub issue — and it does so using the one cross-host observable
that path already talks to: **GitHub itself**.

## What Changes

- **Auto-file path (`core/scripts/stages/papercut.ts`)** — make dedup + rate-cap + creation
  cross-host-safe by treating GitHub as the shared source of truth, keeping the host-local
  `withLock` only as the cheap intra-host fast path:
  - **Cap from GitHub state, not a single up-front snapshot.** The in-window auto-filed count is
    recomputed from the GitHub issue list at/immediately-before each create, so a second host's
    already-created issue is counted before this host files, bounding overshoot.
  - **Post-create read-back reconciliation.** After each create, re-list improve issues; if the
    just-filed title now appears on more than one open issue (a foreign host raced in the TOCTOU
    window), keep the lowest-numbered open issue and close the rest with an explanatory comment,
    so dedup converges to exactly one open issue per cluster.
  - Both operations stay **best-effort and total** — every failure is caught, logged non-fatal,
    and never fails a run, stage, or batch (the existing #421 invariant is preserved).
- **Remaining `/tmp` lock sites — explicitly assessed, not silently ignored.** The per-issue /
  domain advance lock (`pipeline-run.ts`), the queue-batch serialization, and the live-planning
  marker (`lock.ts`) guard **host-local** resources (one host's worktrees, run-state dir, queue).
  This change records that assessment and declares single-host operation as the engine's
  **supported concurrency scope** for those sites in project docs — no behavior change to them,
  and no new `auto_merge`/coordination service.

## Capabilities

### Modified Capabilities
- `papercut-auto-file`: The auto-file dedup and rate-cap guarantees are strengthened from
  same-host (`withLock`) to **cross-host**, using GitHub-authored issue state plus post-create
  read-back reconciliation so distinct hosts produce no duplicate issue and no cap overshoot.

### New Capabilities
- `cross-host-concurrency-scope`: The engine declares single-host operation as the supported
  concurrency scope for its host-local `/tmp` lock sites, and records an explicit cross-host
  safety assessment of each (advance lock, queue batch, live-planning marker).

## Acceptance Criteria

- [ ] Two runs on distinct hosts, each observing an empty in-window GitHub snapshot for the same
      qualifying cluster, converge to **exactly one open** auto-filed issue for that cluster.
- [ ] Two distinct-host runs filing concurrently leave **no more than `auto_file_max_per_window`**
      open auto-filed issues within the trailing window after reconciliation (no cap overshoot).
- [ ] The in-window cap count is derived from GitHub issue state at/immediately-before each create,
      not solely from one up-front host-local snapshot.
- [ ] After a create, the path reads back the issue list and, on a same-title duplicate, keeps the
      lowest-numbered open issue and closes the rest with an explanatory comment.
- [ ] Reconciliation and cross-host cap logic are best-effort/total: any failure (unauthenticated
      `gh`, throwing list/close, network) is caught, logged non-fatal, and never fails a
      run/stage/batch — the existing #421 invariant is preserved.
- [ ] Single-host behavior is unchanged: when only one host runs, dedup, cap, and output are
      identical to pre-change behavior (no extra close calls, no duplicate reconciliation).
- [ ] The engine's other `/tmp` lock sites (per-issue/domain advance lock, queue batch, live-planning
      marker) are explicitly assessed and project docs declare single-host as the supported
      concurrency scope.
- [ ] Unit tests cover cross-host duplicate reconciliation, cross-host cap convergence, and the
      single-host no-op regression, injected through dependency seams (no real network/git/gh).
- [ ] `npm run ci` passes (core tests, `plugin/` mirror sync, install smoke, `openspec validate --all`).

## Impact

- `core/scripts/stages/papercut.ts` (`autoFilePapercuts`, `AutoFileDeps` — new `closeIssue`/`comment`
  seam; cap recomputation and read-back reconciliation) and its co-located test.
- Project docs (`CLAUDE.md` / README / `openspec/project.md`) gain the single-host supported-scope
  statement.
- No changes to state-machine edges, the advance lock, the queue lock, the live-planning marker,
  or any other stage. No `auto_merge` key and no new coordination service are introduced.
