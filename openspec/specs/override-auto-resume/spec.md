# override-auto-resume Specification

## Purpose
TBD - created by archiving change override-auto-resume. Update Purpose after archive.

## Requirements

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

### Requirement: Auto-resume after override SHALL require a currently valid disposition

After the override command posts a decision and attempts to clear `blocked` and re-enter the advance loop, the engine SHALL treat the disposition as successful for unblock only when the newly recorded decision is currently valid under `governed-overrides`. Auto-resume SHALL NOT advance past a finding solely because a free-form reason string was accepted if authority, evidence, expiry, or subject validity failed. When recording is refused, auto-resume SHALL NOT run.

#### Scenario: valid override auto-resumes as today

- **WHEN** an operator records a currently valid governed override that clears the last blocker
- **THEN** the pipeline SHALL post the decision, clear `blocked` as appropriate, and automatically enter the advance loop
- **AND** the advance loop SHALL observe the active override on first partition

#### Scenario: refused override does not auto-resume

- **WHEN** override recording is refused for unauthorized, expired policy, malformed, or missing-evidence reasons
- **THEN** the pipeline SHALL NOT enter the advance loop as a successful override resume
- **AND** SHALL NOT clear blockers solely from the refused attempt

#### Scenario: resume with only expired historical overrides re-parks

- **WHEN** auto-resume or a subsequent advance runs
- **AND** all matching decisions for residual findings are expired or invalidated
- **THEN** the item SHALL NOT advance past those findings
- **AND** SHALL re-park or remain blocked under ordinary review severity rules

### Requirement: Auto-resume SHALL preserve the no-auto-merge invariant under governance

The advance loop entered after a governed override SHALL stop at `ready-to-deploy` and SHALL NOT merge a pull request, identical to the pre-governance auto-resume rule.

#### Scenario: governed override resume does not merge

- **WHEN** the advance loop entered after a valid governed override reaches `ready-to-deploy`
- **THEN** the loop SHALL stop and finalize
- **AND** SHALL NOT perform a merge
