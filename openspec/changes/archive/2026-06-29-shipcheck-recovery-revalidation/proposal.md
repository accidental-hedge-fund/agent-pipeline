## Why

`shipcheck-gate` (`core/scripts/stages/shipcheck.ts`) is the last gate before
`ready-to-deploy`. When it returns a failing/partial verdict in gate mode it
blocks the issue with `shipcheck-failed` (since #302) and the `shipcheck-failed`
recovery recipe directs the operator to **fix in the worktree, commit, clear
`blocked`, and re-run**. The issue stays on `pipeline:shipcheck-gate`.

On the next pass `shipcheck.advance` re-runs the reviewer and, on a `pass`,
transitions straight to `ready-to-deploy` with **no push requirement, no
local-vs-PR head check, and no route back through the earlier gates** (pre-merge
CI status checks, eval-gate, review-SHA re-review). The reviewer runs inside the
issue worktree, so it evaluates the operator's local fix even if that fix was
never pushed. Two failure modes result:

- **Stale PR marked ready** — the fix is committed locally but never pushed. The
  worktree HEAD now differs from the PR head; the reviewer passes on the local
  code; the gate marks a PR ready that does **not** contain the fix.
- **New head bypasses the gates** — the fix is pushed. The new PR head is blessed
  by shipcheck without ever re-running CI status checks, eval-gate, or the
  review-SHA delta review for that head.

This was surfaced by the pre-merge delta review on PR #316 / issue #302 (finding
`e578d432`, HIGH, confidence 0.88), found **out of scope** for #302, and deferred
here via an audited `--override`. It describes **pre-existing** shipcheck-gate
recovery behavior — #302 only changed the block-path `blockerKind`. After #302,
`shipcheck-gate` is a hard stop in `isAutoLoopEligible`, so the only recovery is
this manual operator fix-and-rerun, which makes the gap reachable on every
shipcheck failure.

## What Changes

A **head-coherence gate** runs at the start of `shipcheck.advance` (on the
enabled path, before the reviewer is invoked and before any transition to
`ready-to-deploy`):

- **Unpushed-fix block.** When the issue worktree exists and its local HEAD
  differs from the linked PR head, the stage blocks with a new `head-drift`
  blocker kind instead of advancing. The block reason names both SHAs; the recipe
  tells the operator to push the local commits. A local-only fix can no longer
  mark a stale PR ready.
- **Post-verdict re-validation routing.** The shipcheck verdict comment records
  the PR head SHA it evaluated as `<!-- shipcheck-sha: <full-sha> -->`. On
  re-entry, when a prior shipcheck verdict comment (authored by the authenticated
  pipeline actor) recorded a SHA that differs from the current PR head **and** at
  least one commit between them is not a pipeline-internal commit
  (`isPipelineInternalCommit`), the stage transitions `shipcheck-gate → pre-merge`
  rather than `ready-to-deploy`. Pre-merge re-runs CI status checks and the
  review-SHA gate (delta review) and forward-routes through eval-gate back to
  shipcheck for the new head. A notice naming the stale and current head SHAs is
  posted before routing back.

The `head-drift` value is added to the `BlockerKind` enum with a push-the-fix
recipe (owned by `blocked-recovery-recipes`) and mapped in
`blockerKindToInterventionKind` to `merge-conflict-or-branch-drift`.

This is rigor-preserving: it **adds** re-validation coverage and removes no
review/gate step. The disabled-shipcheck skip path and the advisory/gate verdict
semantics are unchanged except for the new structural head checks.

## Capabilities

### Modified Capabilities

- `shipcheck-gate`: the stage SHALL refuse to advance to `ready-to-deploy` when
  the worktree head differs from the PR head, and SHALL re-validate a post-verdict
  code fix through pre-merge/eval/review-SHA before advancing, recording the
  evaluated head SHA in its verdict comment.
- `blocked-recovery-recipes`: the `BlockerKind` enum and `BLOCKER_RECIPES` map
  SHALL include a `head-drift` kind whose recipe directs the operator to push the
  local fix.

## Impact

- `core/scripts/stages/shipcheck.ts` — head-coherence gate (worktree-vs-PR head
  block + post-verdict re-validation routing), the `shipcheck-sha` sentinel
  embed/extract, new deps (`getPrDetail`, `getPrCommits`, `getGhActor`,
  `gitInWorktree`/worktree-head reader).
- `core/scripts/types.ts` — add `head-drift` to `BLOCKER_KINDS` + `BLOCKER_RECIPES`.
- `core/scripts/intervention.ts` — map `head-drift` in `blockerKindToInterventionKind`.
- `core/test/` — regression tests (see `tasks.md`); `blocked-recipes.test.ts`
  auto-extends to the new kind.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] When `shipcheck-gate` is re-entered and the PR head has moved past the SHA a
  prior shipcheck verdict evaluated via a non-pipeline-internal commit, the stage
  transitions to `pre-merge` (re-validation) and does **NOT** transition to
  `ready-to-deploy`.
- [ ] The shipcheck verdict comment embeds `<!-- shipcheck-sha: <full-sha> -->`
  carrying the full 40-character SHA of the PR head it evaluated.
- [ ] When the issue worktree's local HEAD differs from the linked PR head, the
  stage blocks with blocker kind `head-drift` and does **NOT** advance to
  `ready-to-deploy`; the block reason names both the local and PR head SHAs.
- [ ] The `head-drift` `BLOCKER_RECIPES` entry directs the operator to push the
  local commits (so the PR head includes the fix), remove the `blocked` label, and
  re-run — it does **NOT** merely tell the operator to clear the label.
- [ ] When the current PR head equals the prior `shipcheck-sha`, or every commit
  since it is pipeline-internal, or no prior shipcheck verdict comment exists
  (first entry), the stage proceeds normally with no spurious route-back — the
  normal forward flow still converges to `ready-to-deploy`.
- [ ] When the issue has no worktree (or no linked PR), the corresponding head
  check is skipped rather than crashing, matching shipcheck's existing
  null-tolerance.
- [ ] `blockerKindToInterventionKind("head-drift")` returns
  `merge-conflict-or-branch-drift`.
- [ ] A regression test asserts that a commit made after a failed shipcheck does
  **not** advance directly to `ready-to-deploy` without re-validation, and the
  test fails against today's code (proven to bite).
- [ ] No review/gate coverage is removed: the disabled-shipcheck skip path and the
  advisory/gate verdict routing are unchanged apart from the new structural head
  checks.
- [ ] `npm run ci` passes end-to-end (core tests + `build.mjs --check` mirror +
  install smoke + `openspec validate --all`).
