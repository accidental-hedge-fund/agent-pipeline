## ADDED Requirements

### Requirement: Status output and generated host SKILLs SHALL carry the recover-parked-once then STOP doctrine

Status output and the four generated host SKILLs SHALL apply the existing outer-supervisor residual-park rule: reflow through `pipeline recover-parked` at most once per park fingerprint, then STOP and notify. They SHALL NOT invent `pipeline override`, drop `blocked`/`needs-human`, or auto-override HIGH/CRITICAL/security/authority. That rule SHALL apply to `pipeline status` (prose and JSON) and generated host SKILLs, not only to `docs/supervisor.md`. Train's in-wave RecoverySupervisor recovery SHALL remain the train path. Status and SKILL text SHALL NOT tell a host to auto-invoke `recover-parked` from inside `pipeline train`. Claude's permission classifier SHALL NOT be required for this doctrine and SHALL NOT be treated as an authorization mechanism. The doctrine SHALL remain host-neutral.

`docs/supervisor.md` SHALL keep the residual-park row that already names recover-parked once then STOP. A regression test SHALL fail if status next-action text, generated SKILL authority/follow text, or the supervisor residual-park row again instructs an inferred override as the autonomous next action.

#### Scenario: Status and SKILL match supervisor residual-park rule

- **WHEN** an operator or outer host reads status output, a generated host SKILL, and `docs/supervisor.md` for a residual review park at current HEAD
- **THEN** all three SHALL name `pipeline recover-parked` once then STOP if still parked
- **AND** none SHALL instruct host-improvised override or label surgery as the default reflow

#### Scenario: Host-neutral doctrine does not depend on Claude permissions

- **WHEN** the same residual park is handled by a Codex, Grok, or OpenCode host
- **THEN** status and SKILL guidance SHALL still forbid inferred override
- **AND** the absence of a permission classifier SHALL NOT be treated as override authority

#### Scenario: Train still does not auto-invoke recover-parked

- **WHEN** supervisor or SKILL text describes a train-held residual park
- **THEN** it SHALL NOT instruct the host to invoke `recover-parked` from inside `pipeline train`
- **AND** in-wave RecoverySupervisor recovery SHALL remain the documented train path
