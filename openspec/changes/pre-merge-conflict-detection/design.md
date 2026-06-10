## Context

The pre-merge gate runs in this order today:

1. Review-SHA gate (bounce to re-review if HEAD moved past reviewed commit)
2. OpenSpec archive (fold change deltas into living specs; push + wait for CI re-run)
3. CI poll — `getPrChecks` → `parseChecksAggregate`; loops until all checks pass
4. Mergeability check — `parseMergeable(getPrDetail(…))`; if CONFLICTING, calls `tryRebaseAndPush`
5. OpenSpec validation gate
6. Advance to terminal stage

When a PR is `CONFLICTING` with the base branch, GitHub does not create `pull_request`-triggered check runs. `getPrChecks` either throws (non-zero exit: "no checks found") or returns `[]`. The catch block for the throw case returns `status: "waiting"`, and `parseChecksAggregate([])` also returns `pending: false / failed: []` which flows to Step 4 — but if `gh pr checks` exits non-zero for a conflicting PR the catch path fires first, returning `waiting` on every iteration. Either way, the item can cycle indefinitely without reaching the mergeability check in Step 4 that would actually detect the problem.

The `tryRebaseAndPush` path already exists and handles both auto-resolvable and non-resolvable conflicts correctly. It just needs to be reachable before CI is polled.

## Goals / Non-Goals

**Goals:**
- Detect `CONFLICTING` mergeability **before** the CI poll so the gate never waits for check runs that cannot appear.
- Reuse the existing `tryRebaseAndPush` + `rebaseAlreadyAttempted` guard to attempt the rebase and prevent looping on unresolvable conflicts.
- Emit a clear "merge conflict — manual rebase needed" block reason (not a generic CI-timeout).
- Leave the "no checks" path for repos with no CI workflow untouched when the PR is **not** CONFLICTING.

**Non-Goals:**
- Auto-resolving non-trivial (three-way) merge conflicts.
- Changing the CI-poll behavior for PRs that are not CONFLICTING.
- Adding new GitHub API calls beyond what is required to read `mergeable`/`mergeStateStatus` early.

## Decisions

### Decision: Fetch PR detail once, before the CI poll

Today `getPrDetail` is called in Step 4 (after CI). Move that call to just before Step 1 (CI) so the result is available for both the new early-conflict check and the existing mergeability check. Pass the result forward to avoid a second round-trip.

**Why not a separate early call?** The PR detail payload already includes `mergeable` and `mergeStateStatus`. Fetching it once and threading the result through avoids a duplicate API call per poll iteration.

**Alternative: check inside `getPrChecks` error handler.** Rejected — the error message from `gh pr checks` is not a reliable conflict signal across GitHub versions. Explicit `parseMergeable` on the detail is the same pattern used in Step 4 and is already tested.

### Decision: Apply `rebaseAlreadyAttempted` guard to the early-conflict path

The CI-failure rebase path in Step 1 gates on `rebaseAlreadyAttempted` to prevent a second rebase attempt from looping forever. The mergeability path in Step 4 currently lacks this guard. The new early-conflict path (and the Step 4 path) should both use the guard — otherwise a non-auto-resolvable conflict would rebase-attempt on every polling iteration until `ci_timeout`.

### Decision: CONFLICTING state means skip CI poll; UNKNOWN state means continue polling

`parseMergeable` returns `"unknown"` when GitHub has not yet computed mergeability. An `UNKNOWN` PR should **not** be treated as a conflict — it could become MERGEABLE. The early check only intercepts `"conflict"` (CONFLICTING / DIRTY), not `"unknown"`.

## Risks / Trade-offs

- **Risk: double rebase in edge case** — If the PR starts as CONFLICTING, rebase succeeds (clean), and then another force-push causes a new conflict before CI passes, the `rebaseAlreadyAttempted` marker prevents a second rebase and the item blocks on "manual rebase needed". This is acceptable; a second forced conflict in the same run is unusual and a human block is the right outcome.
  → Mitigation: the marker file is created per-worktree, so a fresh worktree (new pipeline run) starts clean.

- **Risk: GitHub returns CONFLICTING transiently** — In rare cases GitHub briefly shows a PR as CONFLICTING before resolving it to MERGEABLE once it recomputes the merge ref.
  → Mitigation: the early check only triggers a rebase attempt, not an immediate block. If the rebase is a no-op (nothing to fetch), `git rebase` exits clean and CI re-runs normally. The rebaseAlreadyAttempted marker prevents looping.

## Open Questions

None — all design decisions resolved.
