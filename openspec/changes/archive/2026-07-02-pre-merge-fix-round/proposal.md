## Why

The pre-merge delta review (#228) re-reviews the unreviewed commits since the last approved
review. When it returns blocking findings, the pipeline immediately calls
`setBlocked(..., "needs-human")` (`pre_merge.ts` ~L1138) and stops. A human must then read the
finding, apply the fix, run `npm run ci`, commit + push, remove the `blocked` label, and
re-launch the pipeline. This is the single largest source of manual intervention in
fully-autonomous runs.

In the #356 session pre-merge blocked **four** times, every time on a `correctness`-category,
high-confidence finding that the existing surgical-fix harness could have resolved without human
judgment (`deps.getGhActor` seam missing; 7 tests lacking auth injection; …). Each cost a full
read → fix → CI → commit → unlabel → re-run cycle — ~45 minutes across the four. All four were
mechanically auto-fixable.

The delta reviewer already emits structured JSON with `category`, `severity`, and `confidence` —
all the signal needed to decide *auto-fix vs escalate*. And the pattern already exists in this
same file: `performBoundedSpecRepair` (#356) is a bounded, dependency-injected auto-fix that runs
inside pre-merge for `spec-divergence` findings. This change adds its sibling for
`correctness`/`missing-dep` findings.

## What Changes

- Before blocking on a delta-review `needs-attention` verdict, the pre-merge stage SHALL evaluate
  a **bounded auto-fix eligibility** rule over the blocking findings:
  - **Auto-fixable** iff *every* blocking finding has `category` in the allowlist
    `{ correctness, missing-dep }`.
  - If *any* blocking finding has a category outside the allowlist — including `security`, `scope`,
    `product-judgment-required`, `spec-divergence`, an unrecognized value, or an absent/empty
    category — the stage SHALL skip the auto-fix and escalate directly to `needs-human` (the
    conservative default: auto-fix only on positive signal).
- When eligible **and** no auto-fix has yet been attempted for the current pre-merge entry, the
  stage SHALL perform **exactly one** auto-fix attempt: invoke the implementer harness with the
  surgical-fix prompt (`buildFixPrompt`, #235) scoped to the blocking delta findings, run from the
  issue worktree, commit with the run's `Issue:`/`Pipeline-Run:` trailers, and push to the PR head.
- After a successful auto-fix commit the stage SHALL re-run the delta review **once**. If the
  re-review approves (or all findings drop below the active `review_policy`), pre-merge proceeds.
  If it still blocks, the stage SHALL set `blocked`/`needs-human` and SHALL NOT attempt a second
  auto-fix. **One attempt per pre-merge entry**, enforced crash-safely by recognizing a prior
  auto-fix commit among the post-reviewed-SHA developer commits.
- The auto-fix commit is a **developer** commit: `isPipelineInternalCommit` SHALL continue to
  return `false` for it, so the review-SHA gate re-reviews it. It carries a distinct, documented
  marker (a commit-subject prefix / dedicated trailer) that the one-attempt bound reads — that
  marker MUST NOT make `isPipelineInternalCommit` return `true`.
- The surgical-fix discipline (#235) applies unchanged: minimal finding-scoped diff, the
  destructive-operation guard, and the pre-commit self-check.
- The bounded re-review SHALL NOT consume a review-2 ceiling slot (consistent with the existing
  delta-review budget rule).

## Capabilities

### Added Capabilities

- `pre-merge-fix-round`: bounded, category-gated auto-fix of pre-merge delta-review blocking
  findings, with a strict one-attempt-per-entry bound and developer-commit classification.

### Modified Capabilities

- `pre-merge-delta-recheck`: the "delta review finds blocking findings → block" behavior SHALL
  first route blocking findings through the `pre-merge-fix-round` decision; it escalates to
  `needs-human` only when the fix-round is skipped (non-allowlisted category) or exhausted (one
  attempt already made).

## Impact

- `core/scripts/stages/pre_merge.ts` — the delta-review blocking branch (~L1121–1150); a new
  bounded auto-fix closure/seam analogous to `attemptBoundedRepair`/`performBoundedSpecRepair`.
- `core/scripts/prompts/index.ts` — reuse of `buildFixPrompt` (no prompt template change expected).
- `core/scripts/openspec-consistency.ts` / harness invoke plumbing — reuse of the injectable
  `InvokeFn` seam pattern for a testable production closure.
- `core/test/*` — new regression + drift tests (DI seams only; no real harness/git/network).
- `plugin/` mirror — regenerated after any `core/` change (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] When the pre-merge delta review returns `needs-attention` with one or more blocking findings
  **all** categorized `correctness` or `missing-dep`, and no auto-fix has been attempted for the
  current pre-merge entry, the stage performs exactly **one** auto-fix attempt using the implementer
  harness with the surgical-fix prompt (`buildFixPrompt`), run from the issue worktree.
- [ ] If **any** blocking finding has a category outside `{ correctness, missing-dep }` — including
  `security`, `scope`, `product-judgment-required`, `spec-divergence`, an unrecognized value, or an
  absent/empty category — the stage skips the auto-fix and escalates directly to
  `blocked`/`needs-human`.
- [ ] The auto-fix is bounded: after the auto-fix commit, the delta review re-runs exactly once; if
  it still blocks, the stage sets `blocked`/`needs-human` and does **not** attempt a second auto-fix.
  The bound survives a process restart between the fix commit and the re-review (a subsequent poll on
  the same head recognizes the prior auto-fix commit and escalates rather than re-fixing).
- [ ] The auto-fix commit carries the run's `Issue: #N` and `Pipeline-Run: <id>` trailers and is
  classified as a **developer** commit: `isPipelineInternalCommit(<auto-fix subject>)` returns
  `false`, so the review-SHA gate re-reviews it.
- [ ] The surgical-fix discipline from `fix.md` (#235) is preserved: the auto-fix prompt is
  `buildFixPrompt` output (minimal diff, destructive-operation guard, pre-commit self-check) — no
  looser prompt is used for the pre-merge fix round.
- [ ] On any auto-fix failure (harness error, dirty/uncommitted worktree, or no commit produced) the
  stage rolls back to the pre-fix HEAD over a clean worktree and escalates to `needs-human` — it does
  **not** push a partial fix.
- [ ] No auto-fix is attempted on the first pre-merge entry when the SHA gate skips the delta review
  because there is no prior verdict yet (the auto-fix hook lives inside the delta-review block path).
- [ ] The bounded re-review does not increment the `max_adversarial_rounds` counter (no review-2
  ceiling slot consumed).
- [ ] Regression tests cover: (a) blocks on all-`correctness` findings → auto-fix attempted →
  re-review passes → pre-merge advances; (b) blocks on a `product-judgment-required` finding → no
  auto-fix → immediate `needs-human`; (c) the one-attempt bound (second consecutive blocking delta
  review after an auto-fix commit → `needs-human`, no second attempt); (d) the auto-fix commit is
  developer-classified. Tests use the DI seams (no real harness/git/network) and bite without the
  change.
- [ ] `npm run ci` passes end-to-end (core tests + `build.mjs --check` mirror + install smoke +
  `openspec validate --all`).
