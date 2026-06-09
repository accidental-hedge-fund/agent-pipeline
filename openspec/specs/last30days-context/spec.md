# last30days-context Specification

## Purpose
An opt-in, off-by-default, always-non-blocking pre-planning step: when enabled, it gathers a short research brief about the issue and carries it into the planning prompt, so planning starts with recent external context. It must never block or alter planning when disabled, unavailable, or empty. (The research-topic derivation/redaction is refined by `last30days-full-issue-topic`; the not-available/no-signal setup hints are refined by `last30days-setup-hint`.)

## Requirements

### Requirement: Off by default
`cfg.last30days.enabled` SHALL default to `false`. When disabled, `gatherCarryForward` SHALL return an empty brief immediately without invoking the skill, and planning behavior SHALL be identical to having no last30days step.

#### Scenario: disabled by default
- **WHEN** a repo does not configure `last30days`
- **THEN** `cfg.last30days.enabled` SHALL be `false`
- **AND** `gatherCarryForward` SHALL return `""` without invoking the research skill

### Requirement: Always non-blocking
The step SHALL never block the pipeline or throw into planning. If the skill is unavailable, fails, times out, or yields no usable signal, `gatherCarryForward` SHALL resolve to `""` and planning SHALL proceed unchanged.

#### Scenario: skill unavailable
- **WHEN** the step is enabled but the research skill is not installed or its runtime is missing
- **THEN** `gatherCarryForward` SHALL return `""` and planning SHALL proceed without a brief

#### Scenario: no usable signal
- **WHEN** the skill runs but produces a brief with no signal
- **THEN** no brief comment SHALL be posted and planning SHALL proceed unchanged

### Requirement: When enabled with signal, the brief is posted and carried into planning
When the step is enabled and the skill returns a brief with signal, the pipeline SHALL post it as a pre-planning context comment on the issue and inject it into the planning prompt.

#### Scenario: brief with signal
- **WHEN** the step is enabled and the skill returns a brief that has signal
- **THEN** the brief SHALL be posted as a pre-planning context comment
- **AND** the same brief SHALL be injected into the planning prompt
