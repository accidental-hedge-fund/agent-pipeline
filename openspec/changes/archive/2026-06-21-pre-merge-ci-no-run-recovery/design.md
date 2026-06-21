## Context

`gh pr checks` reports required branch-protection checks as "pending" even when no
GitHub Actions workflow run has been created for the head SHA. This means
`parseChecksAggregate` returns `{ pending: true }` and the gate loops indefinitely.
The missing signal is the distinction between "a run exists and is pending" vs "no run
has been created at all" — a gap that `gh pr checks` alone cannot close.

The direct API `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` returns
`total_count: 0` in the no-run case, which is the right discriminator.

## Goals / Non-Goals

**Goals**
- Detect "no run at all" within a bounded grace window (not after 900 s timeout).
- Auto-recover for the specific benign case: archive-only diff + prior SHA green.
- Surface a clear, actionable message for any other no-run case.

**Non-Goals**
- Fixing the underlying GitHub Actions non-trigger (that is a GitHub bug, not ours).
- Adding `workflow_dispatch` trigger to `ci.yml` (would require repo-config changes
  outside the pipeline's control).
- Replacing the existing CI timeout mechanism entirely.

## Decisions

**Decision: Use the commits check-runs API, not `gh pr checks`.**
`gh pr checks` conflates "required check not started" with "check running". The
`/commits/<sha>/check-runs` endpoint returns `total_count: 0` unambiguously. This is
the same API the manual recovery procedure used (`gh api .../check-runs --jq
.total_count`). We wrap it as `getHeadCheckRunCount(cfg, sha)` in `gh.ts` for
testability.

**Decision: Grace window before acting (`ci_no_run_grace_s`, default 60 s).**
A check-run count of 0 immediately after a push is normal (Actions has a lag of a
few seconds to a minute before creating the run). Acting instantly would false-fire on
every normal push. 60 s is generous compared to typical Actions queue lag while still
being well under `ci_timeout` (900 s).

**Decision: Archive-only diff + prior-SHA-green as the recovery gate.**
Close+reopen has side-effects (PR timeline noise, `synchronize` events). We constrain
auto-recovery to the specific case where it is safe: the archive commit changes ONLY
`openspec/` paths (no application code) AND the immediately-preceding commit already
had a green run. When either condition is missing, we surface an error and let the
operator decide — we do not auto-close/reopen on arbitrary diffs.

**Decision: Pre-archive SHA is tracked in pre_merge.ts, not re-derived.**
The pre-merge stage already has the SHA before the archive commit is pushed (it has
just called `maybeArchiveOpenspec`). We capture the head SHA before the archive push
and pass it to the CI-gate path. This avoids a separate git/gh lookup.

**Decision: Injectable deps for zero-run detection and close/reopen.**
`getHeadCheckRunCount`, `closePr`, and `reopenPr` are injected via the existing
`AdvancePreMergeDeps` pattern so unit tests can exercise the path without real GitHub
calls. The production defaults delegate to `ghRun`-based helpers.

**Decision: Close+reopen is attempted at most once per head SHA.**
The gate tracks the SHA for which a no-run recovery was attempted (stored as
`noRunRecoveryAttemptedForSha` in the deps/state object injected into the CI-gate
path). Before calling `closePr`/`reopenPr`, the gate checks whether the current
head SHA matches `noRunRecoveryAttemptedForSha`; if it does, the gate skips
close+reopen and surfaces an actionable error instead (treating it the same as the
non-archive-only case). After a successful close+reopen, `noRunRecoveryAttemptedForSha`
is set to the current head SHA so subsequent polls for the same SHA do not repeat the
operation. This prevents the `advancePolling` loop from triggering repeated PR state
churn when GitHub still reports 0 check-runs on the poll immediately following
close+reopen. If the close+reopen itself fails (PR already closed, rate limit), the
gate surfaces the error and blocks with `needs-human`.

## Risks / Trade-offs

- *Grace window too short* → premature close+reopen on a normally-slow Actions queue.
  Mitigated by making `ci_no_run_grace_s` configurable; 60 s is conservative.
- *Close+reopen fires a second workflow run on the pre-archive SHA* → harmless; the
  reopen event triggers a new run on the current head SHA (the archive commit), which
  is the desired outcome.
- *Close+reopen fails due to branch protection or PR already merged* → surfaced as an
  error, gate blocks with `needs-human`. Not silent.
