## MODIFIED Requirements

### Requirement: Optional and advanced topics are visually separated from core flow
Advanced, optional, or less-common topics — including OpenSpec integration, last30days context, configurable steps, eval gate, and development — SHALL appear in sections that are clearly labeled as optional/advanced and positioned after the core getting-started flow, so a newcomer can reach a working setup without reading through advanced content. Companion review modes are removed and SHALL NOT appear as optional topics.

#### Scenario: Newcomer can reach working setup without reading optional sections
- **WHEN** a first-time reader follows only the prerequisite, install, and quickstart sections
- **THEN** they SHALL reach a working setup without requiring information from any optional/advanced section

#### Scenario: Optional sections are labeled
- **WHEN** a section covers an optional feature
- **THEN** the section heading or lead sentence SHALL indicate the feature is optional (e.g., "(optional)", "default off", or similar)

### Requirement: All instructions are accurate to current tool behavior
Every instruction, command, flag, and description in the README SHALL reflect the tool's actual behavior as of the change. No step SHALL contradict how the installer, pipeline commands, reviewer wiring, or config keys currently work.

#### Scenario: Install commands match installer implementation
- **WHEN** a reader runs any install command shown in the README
- **THEN** the command SHALL execute without error against the current installer (flags, env vars, and host names used in examples SHALL be valid)

#### Scenario: Reviewer wiring description matches default behavior
- **WHEN** the README describes how review is invoked
- **THEN** it SHALL accurately describe the `reviewMode: prompt-harness` path (direct CLI invocation with a JSON prompt, no plugin required); the companion modes (`claude-companion`, `codex-companion`) SHALL NOT be mentioned as valid or optional alternatives

#### Scenario: Config key examples are valid
- **WHEN** the README shows a `.github/pipeline.yml` example block
- **THEN** every key shown SHALL be a currently recognized config key; no deprecated or non-existent keys (`auto_merge`, `harnesses`) SHALL appear
