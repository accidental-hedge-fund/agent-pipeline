## ADDED Requirements

### Requirement: override SHALL automatically re-enter the advance loop after recording the disposition

After `--override "<key>: <reason>"` posts the audited sentinel and clears `blocked`, the pipeline SHALL automatically invoke the advance loop rather than stopping and printing a re-run prompt. The advance loop SHALL execute with the override sentinel already present, so `partitionFindings` sees the disposition on its first evaluation.

#### Scenario: override with no remaining blockers causes the item to advance

- **WHEN** an operator runs `--override "<key>: <reason>"`
- **AND** the recorded override is the last unresolved blocker
- **THEN** the pipeline SHALL post the sentinel, clear `blocked`, and immediately enter the advance loop without printing a re-run prompt
- **AND** the item SHALL advance to the next stage as if the operator had re-run the pipeline manually

#### Scenario: override with remaining blockers re-parks at needs-human

- **WHEN** an operator runs `--override "<key>: <reason>"`
- **AND** one or more other blocking findings remain unresolved after the override is applied
- **THEN** the advance loop SHALL re-park the item at `needs-human`
- **AND** SHALL NOT advance past any unresolved blocker

#### Scenario: override on a needs-human item flips the label before advancing

- **WHEN** an operator runs `--override` on an item currently at stage `needs-human`
- **THEN** the pipeline SHALL read the `round` from the latest `## Pipeline: Review ceiling reached` comment
- **AND** SHALL flip the label from `pipeline:needs-human` to `pipeline:review-<round>`
- **AND** SHALL then enter the advance loop from `review-<round>`

#### Scenario: override on a needs-human item with no ceiling comment errors clearly

- **WHEN** an operator runs `--override` on an item currently at stage `needs-human`
- **AND** no comment on the item starts with `## Pipeline: Review ceiling reached`
- **THEN** the pipeline SHALL exit with a clear error message describing the missing ceiling comment
- **AND** SHALL NOT enter the advance loop
- **AND** SHALL NOT flip any label

### Requirement: auto-resume SHALL preserve the no-auto-merge invariant

The advance loop entered after `--override` SHALL stop at `ready-to-deploy` identically to a manual re-run. The pipeline SHALL NOT merge a pull request as a result of the auto-resume.

#### Scenario: auto-resume loop stops at ready-to-deploy

- **WHEN** the advance loop entered after `--override` reaches `ready-to-deploy`
- **THEN** the loop SHALL stop and finalize, identical to a manually-invoked run
- **AND** SHALL NOT perform a merge
