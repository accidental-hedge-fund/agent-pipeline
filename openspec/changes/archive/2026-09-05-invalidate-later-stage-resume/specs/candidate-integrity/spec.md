## ADDED Requirements

### Requirement: Non-pipeline-internal HEAD movement after review SHALL invalidate later-gate evidence for the prior SHA

The engine SHALL treat a non-pipeline-internal commit that moves the linked PR HEAD past the SHA that current review evidence approved as a new candidate epoch. Prior review, test, visual, eval, shipcheck, and ready-to-deploy evidence bound to the previous SHA SHALL NOT authorize later gates or `pipeline:ready-to-deploy` for the new HEAD. Exact-SHA match and pipeline-internal-only exemptions on a still-current review SHA SHALL remain unchanged. This invalidation SHALL apply on later-stage resume even when no covered pipeline-owned mutation (`restack`, `rebase`, `conflict_repair`, `pre_merge_autofix`, `recovery_repair`) produced the new HEAD.

#### Scenario: Developer commit after review cannot keep later-gate authority

- **WHEN** review evidence is bound to SHA S
- **AND** a non-pipeline-internal commit moves PR HEAD to H
- **AND** the issue is labeled `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **THEN** evidence bound to S SHALL NOT authorize those later stages or ready-to-deploy for H
- **AND** the engine SHALL require review of H before later-gate progress

#### Scenario: Pipeline-internal-only movement does not invalidate a clean approval

- **WHEN** review evidence is bound to SHA S
- **AND** every commit since S is pipeline-internal under the existing classifier
- **THEN** that clean approval SHALL remain current for later-stage dispatch
- **AND** the engine SHALL NOT start a new candidate epoch solely for those internal commits
