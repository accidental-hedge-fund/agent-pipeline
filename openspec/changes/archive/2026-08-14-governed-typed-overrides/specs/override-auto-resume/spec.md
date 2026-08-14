## ADDED Requirements

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
