## ADDED Requirements

### Requirement: Accepted OpenSpec refinements SHALL become the authoritative implementation artifact

After plan review requests revision, Pipeline SHALL treat revision acknowledgement and artifact application as separate gates. Acknowledgement success SHALL NOT prove that the OpenSpec change was refined. Before implementation, Pipeline SHALL establish that the accepted refinement is reflected in one coherent authoritative change, structurally validate that change, reread its proposal, tasks, and spec deltas from the issue worktree, and derive the implementation input from those reread artifacts.

The revision producer SHALL receive format-specific instructions to edit the identified OpenSpec proposal, tasks, and relevant spec deltas when accepted feedback requires a change. Freeform revision SHALL retain its stdout-only contract. When review approves the OpenSpec artifact and no eligible human feedback requires a change, an unchanged artifact SHALL remain valid. Structural validation SHALL be bound to one stable bundle: Pipeline SHALL compare the proposal, tasks, and spec deltas immediately before and after validation, reject intervening mutation, and use that same validated bundle for revised-plan publication and implementation input.

Every planning invocation SHALL build prompt context from the current capped and sanitized eligible human comments even when an older `Pre-Planning Context` comment already exists. Snapshot publication SHALL remain idempotent. Eligible feedback posted after the prior plan SHALL remain available to the reviewer, revision producer, and acknowledgement gate when the replan posts a replacement plan; pipeline-generated comments SHALL NOT be elevated as human feedback.

When eligible human feedback exists, the OpenSpec revision producer SHALL place its genuine `## Human Feedback Acknowledgement` section in both its response and the authoritative `proposal.md`. The post-revalidation acknowledgement gate SHALL evaluate the stable validated proposal because that proposal supplies revised-plan publication and implementation input. An acknowledgement present only in discarded revision stdout SHALL NOT satisfy the gate. Pipeline SHALL NOT synthesize, copy, or infer an acknowledgement on the producer's behalf. Freeform revision SHALL retain its stdout-only acknowledgement contract.

A required substantive refinement SHALL fail explicitly when it is unchanged or was not applied to the authoritative change. Any refinement SHALL fail when it conflicts across its proposal, tasks, or spec deltas, or fails structural validation. Pipeline SHALL NOT substitute the previously accepted proposal or revision stdout for a missing application while reporting refinement success. This requirement SHALL leave the freeform planning path unchanged.

#### Scenario: Applied refinement reaches implementation

- **WHEN** plan review requests a substantive OpenSpec revision
- **AND** the revision worker applies that refinement coherently to the authoritative change
- **AND** the revised change passes structural validation
- **THEN** Pipeline SHALL reread the revised proposal, tasks, and spec deltas from that change
- **AND** the implementation input SHALL contain the accepted refined artifact content rather than the prior proposal

#### Scenario: Revision producer edits the identified change

- **WHEN** plan review or eligible human feedback requires a substantive OpenSpec revision
- **THEN** the revision prompt SHALL direct the producer to edit the identified proposal, tasks, and relevant spec deltas in the issue worktree
- **AND** SHALL NOT present returned Markdown alone as authoritative application

#### Scenario: Approved artifact may remain unchanged

- **WHEN** plan review approves the OpenSpec artifact and no eligible human feedback requires a change
- **THEN** an unchanged structurally valid authoritative bundle SHALL remain valid
- **AND** freeform revision SHALL retain its existing stdout-only behavior

#### Scenario: Validation is bound to a stable bundle

- **WHEN** any proposal, tasks, or spec-delta content changes during structural validation
- **THEN** Pipeline SHALL reject the revision as lacking a stable validated bundle
- **AND** SHALL NOT publish or implement from the replacement content

#### Scenario: Replan retains current human feedback

- **WHEN** eligible human feedback is posted after a prior plan and after an older context snapshot
- **AND** a replan posts a replacement implementation plan
- **THEN** the current feedback SHALL reach the author, reviewer, revision producer, and acknowledgement gate
- **AND** Pipeline SHALL NOT post a duplicate snapshot or treat pipeline-generated comments as human feedback

#### Scenario: OpenSpec acknowledgement survives authoritative reread

- **WHEN** eligible human feedback requires acknowledgement during an OpenSpec revision
- **AND** the revision producer writes its genuine `## Human Feedback Acknowledgement` section to both stdout and the authoritative `proposal.md`
- **AND** the proposal, tasks, and spec deltas form a stable valid bundle
- **THEN** post-revalidation acknowledgement SHALL succeed against the authoritative proposal
- **AND** the same proposal SHALL supply revised-plan publication and implementation input

#### Scenario: Stdout-only OpenSpec acknowledgement fails

- **WHEN** the revision producer returns a valid acknowledgement in stdout
- **AND** the stable authoritative `proposal.md` omits that acknowledgement
- **THEN** Pipeline SHALL reject the revision before revised-plan publication or implementation
- **AND** SHALL NOT copy, synthesize, or infer the missing acknowledgement
- **AND** the freeform stdout-only contract SHALL remain unchanged

#### Scenario: Acknowledged but unapplied refinement fails

- **WHEN** the revision output acknowledges the review request
- **AND** the authoritative OpenSpec artifacts remain unchanged or do not contain the accepted substantive refinement
- **THEN** Pipeline SHALL reject the revision before implementation
- **AND** it SHALL NOT deliver the prior proposal as though refinement succeeded

#### Scenario: Incoherent or invalid refinement fails

- **WHEN** revision changes one or more OpenSpec artifacts but leaves the authoritative change incoherent or structurally invalid
- **THEN** Pipeline SHALL surface an explicit OpenSpec refinement failure with bounded validation evidence
- **AND** implementation SHALL NOT start from either the invalid change or the prior accepted plan

#### Scenario: Freeform revision behavior is unchanged

- **WHEN** planning runs in a repository without the active OpenSpec flow
- **THEN** revision acknowledgement and implementation input SHALL continue to use the existing freeform contract
- **AND** no OpenSpec artifact-application gate SHALL be required
