## ADDED Requirements

### Requirement: Outer supervisors SHALL reflow parked residuals only via recover-parked CLI

External supervisors and thin hosts (including Tugboat composition, Hermes/host skill guidance, and `docs/supervisor.md` failure tables for residual review parks) SHALL direct post-park reflow of review residuals through the engine `pipeline recover-parked` command at most once per park fingerprint, or else STOP and notify a human. They SHALL NOT invent `pipeline override` dispositions, silently drop `blocked`/`needs-human`, reclassify structured HIGH/CRITICAL/security findings, or grow a second recoverer/state machine for this purpose. True human-authority classes (`human-decision-required`, missing authority, product judgment) and still-valid HIGH/CRITICAL/security residuals after recover-parked SHALL remain human wait/handoff work. Deterministic engine classes (scratch unlink, stale-SHA resume) SHALL continue to prefer engine recipes before any supervisor senior pass.

#### Scenario: Supervisor docs point residual parks at recover-parked

- **WHEN** an operator or outer host reads supervisor guidance for a residual review park at current HEAD after deterministic resume
- **THEN** the documented action SHALL be `pipeline recover-parked` once (or equivalent CLI) then STOP if still parked
- **AND** it SHALL NOT instruct host-improvised override or label surgery as the default reflow

#### Scenario: Host must not auto-override CRITICAL residuals

- **WHEN** a parked residual includes structured CRITICAL or security findings
- **THEN** outer-host guidance SHALL NOT teach auto-override of those keys
- **AND** recover-parked refuse + human notify remains the correct outcome

#### Scenario: Supervisor authority boundary unchanged for merge

- **WHEN** supervisor or Tugboat docs mention recover-parked
- **THEN** they SHALL still forbid inventing merge authority, auto_merge config, or a second control plane outside existing operator-authorized merge commands
