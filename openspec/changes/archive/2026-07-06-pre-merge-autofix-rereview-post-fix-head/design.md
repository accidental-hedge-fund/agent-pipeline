## Context

The pre-merge review-SHA gate (`enforceReviewShaGate` in `core/scripts/stages/pre_merge.ts`)
runs a bounded auto-fix when a delta review returns all-auto-fixable blocking findings
(#359/#364). On a successful `performPreMergeAutoFix`, it re-runs the delta review exactly
once and, if that clears, advances pre-merge.

The current re-review branch resolves the post-fix head like this:

```
const newPrHead = (await getPrDetailFn(cfg, prNumber)).head_sha;   // gh pr view --json headRefOid
const reReviewDiff = reviewed.sha
  ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, newPrHead)
  : currentDiff;
```

`getPrDetail` reads the PR head from the GitHub API. Immediately after `git push`, that API
value lags — it can still return the **pre-fix** head. When it does:

- `reReviewDiff = reviewed.sha...<pre-fix-head>` is byte-identical to the first review's
  `deltaDiff` (matching the observed identical prompt sizes), so the reviewer re-emits the
  finding the auto-fix already resolved.
- The re-review comment records `commitSha = newPrHead = <pre-fix-head>`, anchoring
  `reviewed-sha` to the pre-fix commit (matching the observed evidence).

`performPreMergeAutoFix` already computes the true post-fix commit locally (it rev-parses
`HEAD` after the amend and pushes the branch), but discards that SHA — its result type is
just `"fix-committed" | "error"`.

## Goals / Non-Goals

Goals:
- Make the re-review evaluate the diff that includes the auto-fix commit, deterministically,
  without depending on GitHub-API head propagation timing.
- Anchor the re-review's recorded `reviewed-sha`/`verdict-diff-hash` to the post-fix head.
- Keep all existing guards: one-attempt bound, review-2 ceiling exemption, conservative
  fall-through, and the surgical-fix discipline.

Non-Goals:
- No change to the auto-fixable category allowlist (#359).
- No change to the review-SHA gate's internal-commit classification (#16/#98).
- No polling/sleep-until-API-catches-up hack — the local SHA is already authoritative.

## Decision

Carry the authoritative post-fix commit SHA back from `performPreMergeAutoFix` and use it as
`newPrHead` in the re-review branch, instead of re-reading it from `getPrDetail`.

- **Result shape:** widen the success result to include the post-fix head, e.g.
  `{ status: "fix-committed", headSha }`, sourced from `git rev-parse HEAD` in the worktree
  after the amend (the value already computed in the push path). `"error"` is unchanged.
- **Re-review diff:** compute `reviewed.sha...<headSha>` from a source that has the object.
  The auto-fix commit is created in the issue worktree; `defaultGetCommitDeltaDiff` currently
  runs `git diff` in `cfg.repo_dir`, which may not have the just-pushed object. Prefer running
  the delta diff from the issue worktree (which authored the commit), or fetch the object into
  `cfg.repo_dir` first. Either way, the diff range end is the local post-fix head.
- **Sentinels:** record `commitSha`/`verdict-diff-hash` in the re-review comment against
  `headSha` and the post-fix diff hash.

**Why not just keep re-reading `getPrDetail`?** The API read is racy by construction; there is
no bounded, reliable delay after which it is guaranteed fresh. The locally-produced SHA is
authoritative and already in hand, so the read is both unnecessary and the source of the bug.

**Fall-through preserved.** The existing `#359 R2 F1` discipline — do not approve a stale diff
while recording a new head — is kept: if the post-fix head is missing or its delta diff cannot
be computed, the exception propagates to the outer catch and routes to the conservative full
re-review, rather than reusing `currentDiff` or recording a post-fix `reviewed-sha` over a
stale diff.

## Risks / Trade-offs

- **Worktree vs. repo_dir for the delta diff:** running the diff from the issue worktree
  guarantees the object exists but changes the CWD assumption of `getCommitDeltaDiff`. Mitigated
  by threading the worktree path already resolved for the delta reviewer (`deltaWorktreePath`)
  or by an explicit fetch; covered by the deps-seam test that asserts the two review invocations
  receive different diffs.
- **Post-fix head vs. concurrent push:** if a human pushes during the auto-fix, the local head
  and the remote head can diverge. The existing post-approval HEAD re-validation guard (compare
  `getPrDetail().head_sha` to the head we reviewed) still runs after the re-review approves, so a
  concurrent push is caught and re-enters the SHA gate rather than advancing on a stale approval.

## Test Strategy

Extend the pre-merge auto-fix tests (deps seam; no real harness/git/network):

- Stub `attemptPreMergeAutoFix` to return `fix-committed` with a distinct post-fix head, and a
  `getCommitDeltaDiff` fake keyed by the head SHA so the pre-fix and post-fix ranges yield
  different diff strings. Assert the second `runDeltaReview` invocation receives the post-fix
  diff and that the posted re-review comment's `reviewed-sha` equals the post-fix head.
- Bite check: point the re-review head back at the stale `getPrDetail` value and assert the
  "different diff / post-fix anchor" test fails.
- Regression guard: the existing advance-on-resolve, escalate-on-unresolved, one-attempt-bound,
  and developer-classification tests continue to pass unchanged.
