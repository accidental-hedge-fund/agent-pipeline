## ADDED Requirements

### Requirement: The guard SHALL classify an unresolved spec-divergence by direction from a structured signal

The consistency guard SHALL classify an unresolved spec-divergence into exactly one direction — `code-behind-spec` (the active delta is authoritative and the implementation must change) or `spec-behind-code` (the accepted current behavior has moved past the active delta and the delta must change) — using a structured marker emitted with the review finding, and SHALL record the determined direction in the advance outcome. The guard SHALL read the direction only from the controlled structured marker and SHALL NOT infer it by keyword-matching the reviewer's free-text prose.

#### Scenario: code-behind-spec direction is recorded

- **WHEN** the most recent review verdict carries a `spec-divergence` finding whose structured direction marker is `code-behind-spec`
- **THEN** the guard SHALL record the direction as `code-behind-spec`
- **AND** SHALL NOT treat the active spec delta as stale on that basis

#### Scenario: spec-behind-code direction is recorded

- **WHEN** the most recent review verdict carries a `spec-divergence` finding whose structured direction marker is `spec-behind-code`
- **THEN** the guard SHALL record the direction as `spec-behind-code`
- **AND** SHALL treat the active spec delta as a stale-delta candidate

#### Scenario: direction is read from the structured marker, never prose

- **WHEN** a review finding's prose mentions the spec being "behind the code" or "stale" but carries no structured direction marker
- **THEN** the guard SHALL NOT derive a direction from that prose
- **AND** SHALL treat the divergence as unclassified

### Requirement: The guard SHALL NOT force spec repair or block a fix round without positive evidence the active delta is stale

The guard SHALL require or attempt spec-delta repair only when there is positive structured evidence that the active delta no longer describes the accepted current behavior (a `spec-behind-code` direction reflecting the current state). When the direction is `code-behind-spec` or the divergence is unclassified, the guard SHALL NOT force spec-delta repair and SHALL NOT block the advance solely because implementation files changed after the latest spec-delta edit.

#### Scenario: implementation-only fix satisfying an existing requirement advances (the #849 shape)

- **WHEN** the active spec delta already requires the target behavior
- **AND** a review finding flags the implementation for violating that requirement (direction `code-behind-spec`)
- **AND** a later fix-round commit changes only implementation/test files to satisfy the requirement, leaving `specs/**` untouched
- **THEN** the guard SHALL NOT post an `openspec-stale-delta` blocker
- **AND** the run SHALL advance so normal review convergence can confirm the fix

#### Scenario: unclassified spec-divergence marker does not force spec repair

- **WHEN** a review finding is tagged `category: spec-divergence` with no direction marker
- **AND** implementation files changed after the last `specs/**` change
- **THEN** the guard SHALL NOT require or attempt a spec-delta repair
- **AND** SHALL NOT block the advance on the file-order signal alone

### Requirement: The stale-delta decision SHALL reflect the current post-fix state

The guard SHALL treat a spec-divergence as unresolved only when it reflects the current post-fix head. A `spec-divergence` marker carried by a review verdict that predates a later fix commit SHALL NOT, by itself, drive the stale-delta decision; the decision SHALL be based on the divergence signal that corresponds to the current head.

#### Scenario: a pre-fix marker resolved by a later fix is not treated as stale

- **WHEN** a review verdict tagged a `spec-divergence` finding
- **AND** a later fix-round commit changed the implementation after that verdict
- **AND** no divergence signal corresponds to the post-fix head
- **THEN** the guard SHALL NOT treat the active delta as stale based on the earlier marker
- **AND** SHALL allow the advance

#### Scenario: a divergence that persists against post-fix head is unresolved

- **WHEN** the divergence signal for the current post-fix head has direction `spec-behind-code`
- **THEN** the guard SHALL treat the active delta as a stale-delta candidate for the current state

### Requirement: The pipeline SHALL make one bounded automatic spec-delta repair attempt before blocking a genuinely stale delta

When there is positive `spec-behind-code` evidence for the current state, the pipeline SHALL make exactly one automatic spec-delta repair attempt before blocking, and only when that repair can be verified without changing any application code. The attempt SHALL be bounded to a single try per run; a second stale outcome SHALL NOT trigger a further automatic attempt.

#### Scenario: a genuinely stale delta triggers one repair attempt

- **WHEN** the current-state direction is `spec-behind-code`
- **AND** the repair can be verified without changing application code
- **THEN** the pipeline SHALL perform exactly one automatic spec-delta repair attempt before any block

#### Scenario: repair not verifiable without code changes is not auto-attempted

- **WHEN** the current-state direction is `spec-behind-code`
- **AND** bringing the delta into agreement cannot be verified without also changing application code
- **THEN** the pipeline SHALL NOT perform an automatic spec-delta repair
- **AND** SHALL block with a spec-delta-alignment reason

#### Scenario: automatic repair is bounded to a single attempt

- **WHEN** an automatic spec-delta repair attempt completes and the state is still stale
- **THEN** the pipeline SHALL NOT start a second automatic repair attempt in the same run
- **AND** SHALL block with a spec-delta-alignment reason

### Requirement: A bounded spec-delta repair SHALL touch only the active change's spec and tasks, validate, commit with traceability, and re-run the guard once

An automatic spec-delta repair SHALL modify only files under the active change's `openspec/changes/<id>/specs/**` and that change's `tasks.md`. If the attempt changes any other file (including any application or test code), the attempt SHALL be rejected and SHALL NOT be committed. A committed repair SHALL pass `openspec validate <change-id>`, SHALL carry the run's `Issue:` and `Pipeline-Run:` traceability trailers, and the pipeline SHALL re-run the stale-delta guard exactly once afterward before the run advances.

#### Scenario: a valid, code-frozen repair clears the guard and advances

- **WHEN** an automatic repair changes only `specs/**` and `tasks.md` for the active change
- **AND** `openspec validate <change-id>` passes
- **AND** the re-run guard finds the state no longer stale
- **THEN** the repair commit SHALL carry the run's `Issue:`/`Pipeline-Run:` trailers
- **AND** the run SHALL advance

#### Scenario: a repair that touches a disallowed file is rejected

- **WHEN** an automatic repair attempt changes a file outside the active change's `specs/**` or `tasks.md` (for example an application source file)
- **THEN** the attempt SHALL be rejected and SHALL NOT be committed
- **AND** the pipeline SHALL block rather than advance

#### Scenario: the guard is re-run exactly once after a repair

- **WHEN** an automatic spec-delta repair has been committed
- **THEN** the stale-delta guard SHALL be re-run exactly once against the post-repair state before the run advances

### Requirement: A failed, disallowed, invalid, or still-stale repair SHALL block with a direction-specific reason

When the guard blocks, the block reason SHALL state whether the remaining work is *code alignment* (the implementation still diverges from the active spec) or *spec-delta alignment* (the active delta is stale and automatic repair did not bring it into agreement). The blocker SHALL continue to use the `openspec-stale-delta` blocker kind for the spec-delta-alignment case; the direction SHALL be conveyed in the reason text.

#### Scenario: still stale after repair blocks for spec-delta alignment

- **WHEN** an automatic repair attempt completes and the state is still `spec-behind-code`
- **THEN** the pipeline SHALL block with a reason stating that spec-delta alignment is required
- **AND** SHALL NOT archive the change

#### Scenario: code still diverges from the active spec blocks for code alignment

- **WHEN** the current-state direction is `code-behind-spec` and it cannot be resolved by a fix round within the run's limits
- **THEN** the pipeline SHALL block with a reason stating that code alignment is required

#### Scenario: an invalid repair blocks

- **WHEN** an automatic spec-delta repair produces a change that fails `openspec validate <change-id>`
- **THEN** the pipeline SHALL block rather than commit or archive the invalid delta

### Requirement: The stale-delta guard SHALL remain active at fix-round and pre-merge and SHALL never archive a stale delta

The disambiguation and bounded-repair behavior SHALL NOT remove, disable, or lower the stale-delta guard. The guard SHALL continue to run at both fix-round and pre-merge/archive time, and a change whose active delta is known to be stale SHALL NOT be archived into the living specs.

#### Scenario: the guard runs at fix-round time

- **WHEN** a fix round completes on an OpenSpec-active change
- **THEN** the stale-delta guard SHALL be evaluated for that change before the round advances

#### Scenario: the guard runs at pre-merge before archive

- **WHEN** an OpenSpec-active item reaches pre-merge
- **THEN** the stale-delta guard SHALL be evaluated before `openspec archive` is called

#### Scenario: a known-stale delta is never archived

- **WHEN** the current-state direction is `spec-behind-code` and no verified repair has brought the delta into agreement
- **THEN** the pipeline SHALL NOT call `openspec archive` for that change
