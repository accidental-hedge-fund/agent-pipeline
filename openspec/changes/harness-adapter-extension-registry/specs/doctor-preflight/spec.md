## ADDED Requirements

### Requirement: Doctor harness-adapter checks SHALL iterate the runtime registry and assigned adapters

Doctor and run-start preflight checks that assess local-CLI harness readiness SHALL determine which
adapters to check from configuration assignment and the runtime adapter registry, not from a
hardcoded closed list of built-in harness names. When configuration assigns an extension adapter
as implementer or reviewer, doctor SHALL run that adapter's declared readiness / smoke / preflight
hooks. When configuration assigns only a subset of registered adapters, doctor SHALL still be able
to report readiness for those assigned adapters without requiring the adapter ID to be one of the
historical built-in names.

#### Scenario: Assigned extension adapter is included in doctor checks

- **WHEN** configuration assigns registered extension adapter `ext-demo` as implementer
- **AND** `pipeline doctor` runs
- **THEN** doctor SHALL include readiness checks for `ext-demo`
- **AND** a missing CLI for `ext-demo` SHALL fail doctor with remediation naming that adapter

#### Scenario: Doctor does not hardcode only claude and codex as harnesses

- **WHEN** registered adapters include built-ins plus at least one extension adapter and
  configuration assigns a non-claude/non-codex adapter
- **THEN** doctor harness checks SHALL not skip that adapter solely because its name is absent
  from a hardcoded `claude`/`codex` (or five-built-in) list

#### Scenario: Unassigned adapters may be skipped without failing doctor

- **WHEN** an adapter is registered but not assigned by the active configuration
- **THEN** doctor MAY skip deep readiness checks for that unassigned adapter
- **AND** skipping an unassigned adapter SHALL NOT by itself cause doctor to fail
