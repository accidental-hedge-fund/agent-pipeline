## MODIFIED Requirements

### Requirement: README SHALL document the Grok Build skill path

The README SHALL include an install-adjacent subsection for Grok Build consumers
that documents `~/.grok/skills/pipeline`. The preferred installed layout SHALL
remain the existing symlink to the Claude-managed skill install; a copy MAY be
documented as a secondary option. The README SHALL distinguish the generated,
byte-identical `hosts/grok/SKILL.md` repository conformance output from a distinct
Grok install overlay: `--host grok` SHALL continue to materialize the
`symlink-claude` lifecycle, not a separate tree. The subsection SHALL appear
after the primary Claude/Codex quickstart.

#### Scenario: Grok subsection is present and accurate

- **WHEN** a Grok Build user opens the README looking for skill install paths
- **THEN** the README SHALL document `~/.grok/skills/pipeline` as the Grok skill
  location
- **AND** SHALL prefer symlink-to-Claude (or the equivalent under
  `CLAUDE_CONFIG_DIR`) over inventing a third unrelated install tree

#### Scenario: Grok content does not block the primary quickstart

- **WHEN** a first-time reader follows only the primary Claude/Codex install and
  quickstart
- **THEN** they SHALL reach a working Claude or Codex setup without needing the
  Grok subsection

#### Scenario: Grok host status is not overstated

- **WHEN** the README describes `hosts/grok/SKILL.md` or `--host grok`
- **THEN** it SHALL identify the repository file as a generated, byte-identical
  conformance output
- **AND** it SHALL state that installation still exposes the Claude-managed bytes
  through the Grok symlink rather than consuming a distinct Grok overlay
