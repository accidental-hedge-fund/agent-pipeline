## ADDED Requirements

### Requirement: Research topic derived from full issue content
When the pre-planning last30days brief runs, the pipeline SHALL derive its research topic from the issue's title and description combined, not from the title alone.

#### Scenario: Issue has non-empty description
- **WHEN** `last30days.enabled` is `true`
- **AND** the issue has a non-empty, non-whitespace description (body)
- **THEN** the research topic passed to the last30days skill SHALL incorporate both the title and the description content
- **AND** the brief's downstream placement, format, and injection into the planning prompt SHALL be unchanged

#### Scenario: Issue has empty or whitespace-only description
- **WHEN** `last30days.enabled` is `true`
- **AND** the issue body is absent, empty, or whitespace-only
- **THEN** the research topic passed to the skill SHALL be the title alone
- **AND** behavior SHALL be identical to the pre-change baseline (no regression)

### Requirement: Long descriptions are bounded before being passed to the skill
When the issue description exceeds a character threshold, the pipeline SHALL condense it to a bounded representation rather than passing the raw body verbatim.

#### Scenario: Issue body exceeds the length threshold
- **WHEN** the issue body is non-empty and its length exceeds the defined character threshold
- **THEN** the topic passed to the skill SHALL be capped at the threshold, trimmed at a word boundary
- **AND** the truncation SHALL be marked (e.g., `…`) so it is clear content was cut
- **AND** the full body SHALL continue to reach the planning prompt unchanged via the existing `body` argument to `buildPlanningPrompt`

#### Scenario: Issue body is within the length threshold
- **WHEN** the issue body is non-empty and does not exceed the threshold
- **THEN** the body content MAY be appended verbatim to the title in the research topic

### Requirement: Opt-in and non-blocking contract unchanged
The full-issue-topic behavior is part of the existing `last30days` opt-in step. It SHALL inherit all existing non-blocking guarantees: the step MUST remain opt-in and off by default, and any failure or missing signal SHALL not block planning.

#### Scenario: last30days disabled (default)
- **WHEN** `last30days.enabled` is `false` or not set in config
- **THEN** the research topic is never built and the skill is never called
- **AND** planning proceeds identically to today

#### Scenario: Skill unavailable or returns no signal regardless of topic
- **WHEN** the skill is unavailable or returns no usable signal (for any reason)
- **THEN** `gatherCarryForward` SHALL return `""` without blocking or throwing
- **AND** existing hint behavior (see [[last30days-setup-hint]]) SHALL continue to apply
