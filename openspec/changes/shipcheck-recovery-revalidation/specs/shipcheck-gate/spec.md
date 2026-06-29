## ADDED Requirements

### Requirement: shipcheck-gate blocks when the worktree head differs from the PR head

The `shipcheck-gate` stage SHALL, before invoking the reviewer harness and before
any transition to `ready-to-deploy`, compare the issue worktree's local HEAD commit
to the linked PR's head commit. When a worktree exists for the issue and its local
HEAD differs from the PR head, the stage SHALL call `setBlocked` with blocker kind
`head-drift` and SHALL NOT advance to `ready-to-deploy`. The block reason SHALL name
both the local HEAD SHA and the PR head SHA. When no worktree exists for the issue
(or no PR is linked), the stage SHALL skip the worktree-head comparison rather than
crashing.

This prevents a local-only or unpushed post-shipcheck fix from marking a stale PR
ready: the reviewer evaluates the worktree, so without this check a fix that was
committed locally but never pushed could pass shipcheck while the PR a human merges
does not contain the fix.

#### Scenario: worktree HEAD differs from PR head — blocked, not advanced

- **WHEN** the current stage is `shipcheck-gate` and `cfg.shipcheck_gate.enabled` is `true`
- **AND** a worktree exists for the issue whose local HEAD SHA differs from the linked PR head SHA
- **THEN** the stage SHALL call `setBlocked(...)` with blocker kind `head-drift`
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** the block reason SHALL include both the local HEAD SHA and the PR head SHA

#### Scenario: worktree HEAD matches PR head — comparison passes

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the worktree's local HEAD SHA equals the linked PR head SHA
- **THEN** the worktree-head comparison SHALL pass and the stage SHALL continue (it SHALL NOT block with `head-drift`)

#### Scenario: no worktree — comparison skipped

- **WHEN** the current stage is `shipcheck-gate`
- **AND** no worktree exists for the issue
- **THEN** the stage SHALL skip the worktree-head comparison without raising an error
- **AND** SHALL continue to the post-verdict re-validation check

---

### Requirement: shipcheck verdict comment records the evaluated head SHA

The shipcheck verdict comment SHALL embed the full 40-character SHA of the PR head
it evaluated, on its own line as the HTML-comment sentinel
`<!-- shipcheck-sha: <full-sha> -->`. The stage SHALL provide a pure extractor that
reads this sentinel from a comment body and returns the SHA (or null when absent),
mirroring the `reviewed-sha` sentinel of `review-sha-gating`.

#### Scenario: verdict comment carries the shipcheck-sha sentinel

- **WHEN** the shipcheck stage posts a verdict comment for a PR whose head SHA is `<full-sha>`
- **THEN** the comment body SHALL contain the line `<!-- shipcheck-sha: <full-sha> -->`
- **AND** the extractor applied to that body SHALL return `<full-sha>`

#### Scenario: extractor returns null for a comment without the sentinel

- **WHEN** the extractor is applied to a comment body that has no `shipcheck-sha` sentinel
- **THEN** it SHALL return `null`

---

### Requirement: shipcheck-gate re-validates a post-verdict code fix instead of advancing directly

On entry to `shipcheck-gate`, the stage SHALL determine whether a developer/fix
commit has landed on the PR head since the head a prior shipcheck verdict evaluated.
It SHALL read the most recent shipcheck verdict comment authored by the
authenticated `gh` actor and extract its `shipcheck-sha`. When that recorded SHA is
present and differs from the current PR head, and at least one commit between the
recorded SHA and the current head is NOT a pipeline-internal commit (per
`isPipelineInternalCommit`), the stage SHALL transition `shipcheck-gate → pre-merge`
— routing the new head back through CI status checks, the review-SHA gate, and
eval-gate — rather than transitioning to `ready-to-deploy`. Before routing back, the
stage SHALL post a notice naming the stale and current head SHAs.

When the recorded SHA equals the current PR head, when every commit since the
recorded SHA is pipeline-internal (e.g. the OpenSpec archive commit), or when no
prior shipcheck verdict comment exists (first entry), the stage SHALL proceed with
the reviewer evaluation as before — it SHALL NOT route back. Only shipcheck verdict
comments authored by the authenticated `gh` actor SHALL be trusted as the recorded
SHA source.

When a prior verdict comment by the authenticated actor exists but carries no
`shipcheck-sha` sentinel (a legacy comment posted by an older harness version), the
stage SHALL treat it as an unknown prior verdict and SHALL transition
`shipcheck-gate → pre-merge` once, posting a `<!-- shipcheck-revalidation-sha: <current-head> -->`
notice after the transition, so the new head is validated before shipcheck proceeds.
The existing idempotency guard (`alreadyRoutedForCurrentHead`) prevents this migration
route from repeating once the notice is posted.

#### Scenario: developer commit landed since the prior shipcheck verdict — route back to pre-merge

- **WHEN** the current stage is `shipcheck-gate` and `cfg.shipcheck_gate.enabled` is `true`
- **AND** a prior shipcheck verdict comment by the authenticated actor records a `shipcheck-sha` that differs from the current PR head
- **AND** at least one commit between that SHA and the current head is not a pipeline-internal commit
- **THEN** the stage SHALL transition `shipcheck-gate → pre-merge`
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL post a notice naming the stale and current head SHAs before routing back

#### Scenario: recorded shipcheck-sha equals current head — proceed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the prior shipcheck verdict comment's `shipcheck-sha` equals the current PR head
- **THEN** the stage SHALL proceed with the reviewer evaluation and SHALL NOT route back to `pre-merge`

#### Scenario: only pipeline-internal commits since the prior shipcheck verdict — proceed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the current PR head differs from the recorded `shipcheck-sha`
- **AND** every commit between the recorded SHA and the current head is a pipeline-internal commit (`isPipelineInternalCommit`)
- **THEN** the stage SHALL proceed and SHALL NOT route back to `pre-merge` (preventing a non-converging route-back loop on the pipeline's own archive commit)

#### Scenario: first entry — no prior shipcheck comment — proceed and record SHA

- **WHEN** the current stage is `shipcheck-gate` and no prior shipcheck verdict comment exists for the issue
- **THEN** the stage SHALL proceed with the reviewer evaluation
- **AND** the verdict comment it posts SHALL record the evaluated PR head SHA via the `shipcheck-sha` sentinel

#### Scenario: legacy verdict comment (no sentinel) triggers migration routing to pre-merge

- **WHEN** the current stage is `shipcheck-gate`
- **AND** a prior shipcheck verdict comment authored by the authenticated actor exists but has no `shipcheck-sha` sentinel (legacy comment)
- **AND** no `shipcheck-revalidation-sha` notice for the current head has been posted yet
- **THEN** the stage SHALL transition `shipcheck-gate → pre-merge`
- **AND** SHALL NOT proceed to the reviewer evaluation
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL post a notice with `<!-- shipcheck-revalidation-sha: <current-head> -->` after the transition

#### Scenario: revalidation notice is only posted after a successful transition (idempotency marker not orphaned)

- **WHEN** the stage is routing to `pre-merge` (developer commit or legacy migration)
- **AND** the label transition fails before completing
- **THEN** the `<!-- shipcheck-revalidation-sha: … -->` notice SHALL NOT be posted
- **AND** the next run SHALL still route to `pre-merge` (no orphaned idempotency marker)

#### Scenario: a commit made after a failed shipcheck does not advance directly to ready-to-deploy

- **WHEN** shipcheck-gate previously blocked at PR head `H1` and the operator pushed a fix moving the PR head to `H2`
- **AND** shipcheck-gate is re-entered with the worktree HEAD equal to `H2` (the fix is pushed)
- **THEN** the stage SHALL NOT transition directly to `ready-to-deploy`
- **AND** SHALL transition `shipcheck-gate → pre-merge` to re-validate `H2` through CI status checks, the review-SHA gate, and eval-gate

#### Scenario: re-entered after routing to pre-merge for the same head — idempotency guard proceeds with reviewer

- **WHEN** the stage previously routed `shipcheck-gate → pre-merge` for PR head `H2` (posting a notice with `<!-- shipcheck-revalidation-sha: H2 -->`)
- **AND** pre-merge/eval completes and shipcheck-gate is re-entered still at head `H2`
- **THEN** the stage SHALL detect the revalidation-sha notice authored by the authenticated actor and SHALL NOT route back to `pre-merge` again
- **AND** SHALL proceed with the reviewer evaluation for `H2`
- **AND** on a pass verdict SHALL transition to `ready-to-deploy`
- (This prevents the route-back from looping: the prior shipcheck verdict still records `H1`, so without this guard the same developer-commit condition would trigger indefinitely.)

#### Scenario: authenticated actor cannot be resolved — fail closed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** a PR is linked (`prNumber` is non-null)
- **AND** the `gh` actor lookup returns null (transient auth failure)
- **THEN** the stage SHALL call `setBlocked` with blocker kind `needs-human`
- **AND** SHALL NOT proceed to the reviewer evaluation
- **AND** SHALL NOT transition to `ready-to-deploy`

#### Scenario: PR head changes during reviewer run — post-review head-coherence recheck routes to pre-merge

- **WHEN** the reviewer harness completes evaluation of PR head `H2`
- **AND** the PR head has since been updated to `H3` during the reviewer run (a push after the pre-review head fetch)
- **THEN** the stage SHALL re-fetch the PR head after the reviewer completes
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL transition `shipcheck-gate → pre-merge` to re-validate the new head `H3`

#### Scenario: worktree head changes during reviewer run — post-review recheck blocks with head-drift

- **WHEN** the reviewer harness completes evaluation of PR head `H2`
- **AND** the worktree HEAD has since been updated (a local commit during the reviewer run)
- **AND** the worktree HEAD no longer matches the evaluated PR head `H2`
- **THEN** the stage SHALL call `setBlocked` with blocker kind `head-drift`
- **AND** SHALL NOT transition to `ready-to-deploy`
