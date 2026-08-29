## MODIFIED Requirements

### Requirement: Material filter guidance SHALL be consistent across host variants

All host skill variants that document long-running progress notify (at least `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the Grok-consumed path / `hosts/grok/SKILL.md` when present, plus the generated plugin SKILL overlay) SHALL describe the **same** material kind set and spam-suppression rules for the events.jsonl material filter. Host variants SHALL differ only in the host notify map tool names used to surface filter output, not in which event kinds are material.

#### Scenario: Claude and Codex share material kinds

- **WHEN** material kind lists in `hosts/claude/SKILL.md` and
  `hosts/codex/SKILL.md` are compared for advance and loop notify
- **THEN** the required material kinds and suppression rules SHALL match
- **AND** only the notify tool/surface names MAY differ

#### Scenario: Grok path matches the shared material set

- **WHEN** the Grok-consumed skill path documents material progress notify
- **THEN** its material kind set SHALL match the shared filter contract
- **AND** its surface SHALL be Grok `monitor` (or equivalent), not a divergent
  kind list
