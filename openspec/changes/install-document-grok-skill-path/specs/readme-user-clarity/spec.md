## ADDED Requirements

### Requirement: README SHALL document the Grok Build skill path

The README SHALL include an install-adjacent subsection for Grok Build
consumers that documents how to obtain the pipeline skill under
`~/.grok/skills/pipeline`. The preferred documented method SHALL be a symlink
to the Claude-managed skill install; a copy MAY be documented as a secondary
option. The subsection SHALL state that Grok is not a first-class host overlay
with a separate `hosts/grok` SKILL.md package (or, if `--host grok` is
documented, SHALL describe path materialization only). The Grok subsection
SHALL appear after the primary Claude/Codex quickstart so newcomers can finish
the default install without reading Grok-specific layout first.

#### Scenario: Grok subsection is present and accurate

- **WHEN** a Grok Build user opens the README looking for skill install paths
- **THEN** the README SHALL document `~/.grok/skills/pipeline` as the Grok
  skill location
- **AND** SHALL prefer symlink-to-Claude (or the equivalent under
  `CLAUDE_CONFIG_DIR`) over inventing a third unrelated install tree

#### Scenario: Grok content does not block the primary quickstart

- **WHEN** a first-time reader follows only the primary Claude/Codex install
  and quickstart
- **THEN** they SHALL reach a working Claude or Codex setup without needing
  the Grok subsection

#### Scenario: Grok host status is not overstated

- **WHEN** the README describes Grok consumption
- **THEN** it SHALL NOT claim a full third packaged host overlay exists when
  the installer only supports Claude and Codex as first-class hosts
- **AND** if it documents `--host grok`, that command SHALL match the
  installer's implemented behavior

### Requirement: README Grok reinstall note SHALL survive Claude updates

The README Grok documentation SHALL include a reinstall or update note:
after updating the Claude-hosted skill, the operator SHALL re-create the Grok
symlink (or re-run the documented Grok install command when `--host grok`
exists) so the Grok path is not left dangling or stale.

#### Scenario: Update path is actionable from README alone

- **WHEN** an operator updates Claude's pipeline skill and uses Grok via
  symlink
- **THEN** the README SHALL state the follow-up step to refresh the Grok path
- **AND** the step SHALL be runnable from documented commands without reading
  installer source
