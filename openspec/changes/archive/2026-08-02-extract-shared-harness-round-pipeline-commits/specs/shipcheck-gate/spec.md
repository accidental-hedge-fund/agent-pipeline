## MODIFIED Requirements

### Requirement: shipcheck-gate re-validates a post-verdict code fix instead of advancing directly

On entry to `shipcheck-gate`, the stage SHALL determine whether a developer/fix
commit has landed on the PR head since the head a prior shipcheck verdict evaluated.
It SHALL read the most recent shipcheck verdict comment authored by the
authenticated `gh` actor and extract its `shipcheck-sha`. When that recorded SHA is
present and differs from the current PR head, and at least one commit between the
recorded SHA and the current head is NOT a pipeline-internal commit (per
`isPipelineInternalCommit` from the neutral pipeline-commits module), the stage SHALL
transition `shipcheck-gate → pre-merge` — routing the new head back through CI status
checks, the review-SHA gate, and eval-gate — rather than transitioning to
`ready-to-deploy`. Before routing back, the stage SHALL post a notice naming the
stale and current head SHAs.

When the recorded SHA equals the current PR head, when every commit since the
recorded SHA is pipeline-internal (for example the OpenSpec archive commit or an
exact visual-gate artifact-publish commit), or when no prior shipcheck verdict
comment exists (first entry), the stage SHALL proceed with the reviewer evaluation
as before — it SHALL NOT route back. Only shipcheck verdict comments authored by the
authenticated `gh` actor SHALL be trusted as the recorded SHA source.

When a prior verdict comment by the authenticated actor exists but carries no
`shipcheck-sha` sentinel (a legacy comment posted by an older harness version), the
stage SHALL treat it as an unknown prior verdict and SHALL transition
`shipcheck-gate → pre-merge` once, posting a `<!-- shipcheck-revalidation-sha: <current-head> -->`
notice after the transition, so the new head is validated before shipcheck proceeds.
The existing idempotency guard (`alreadyRoutedForCurrentHead`) prevents this migration
route from repeating once the notice is posted.

The shipcheck stage module SHALL obtain `isPipelineInternalCommit` from the neutral
pipeline-commits module and SHALL NOT import that classifier from `stages/pre_merge`.

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
- **THEN** the stage SHALL proceed and SHALL NOT route back to `pre-merge` (preventing a non-converging route-back loop on the pipeline's own archive or visual-publish commit)

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

#### Scenario: shipcheck classification does not import pre_merge

- **WHEN** `stages/shipcheck.ts` resolves `isPipelineInternalCommit` for post-verdict revalidation
- **THEN** the resolution path SHALL use the neutral pipeline-commits module
- **AND** SHALL NOT require importing `stages/pre_merge.ts`
