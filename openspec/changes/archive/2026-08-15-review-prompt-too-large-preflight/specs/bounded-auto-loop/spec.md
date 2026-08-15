## ADDED Requirements

### Requirement: review-prompt-too-large blocks SHALL NOT consume auto-loop recovery retries on the same payload

A `blocked` outcome whose `blockerKind` is `review-prompt-too-large` SHALL be treated as **non-recoverable** by the bounded auto-loop recoverability predicate. When the advance loop encounters such an outcome, it SHALL stop rather than perform an automatic continuation that would re-enter the same review stage and re-assemble or re-send the same oversize prompt.

This requirement does not create a new recovery recipe that retries review. It forbids spending an auto-loop / auto-recovery continuation unit solely to re-invoke review against an unchanged oversize payload after a `review-prompt-too-large` block.

#### Scenario: Auto-loop does not re-drive review after review-prompt-too-large

- **WHEN** `auto_loop.enabled` is `true`, budget remains, and a review stage returns `blocked` with `blockerKind: "review-prompt-too-large"`
- **THEN** the auto-loop recoverability predicate SHALL treat the outcome as non-recoverable
- **AND** the loop SHALL stop without performing an automatic continuation for that block
- **AND** the reviewer harness SHALL NOT be re-spawned solely because of auto-loop continuation after that block

#### Scenario: Other recoverable kinds remain recoverable

- **WHEN** a stage returns `blocked` with a kind that was recoverable before this change (for example a retriable pipeline-owned class other than `review-prompt-too-large`)
- **THEN** that kind’s recoverability SHALL remain unchanged by this requirement
