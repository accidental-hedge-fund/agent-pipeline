## ADDED Requirements

### Requirement: Host skill guidance SHALL document the events.jsonl material filter for progress notify

Host skill orchestration guidance for long-running advance and loop runs SHALL document the shared **events.jsonl material filter** used for progress notify, in addition to any issue-scoped terminal-log Monitor filters. The guidance SHALL recommend composing host follow/monitor with that filter (or an engine `--material` path that implements the same rules) so material stage/loop kinds are surfaced and polling spam is suppressed. The guidance SHALL state that unfiltered `events.jsonl` remains the complete evidence stream and that the material filter is for human-visible progress only.

#### Scenario: Material filter is named in host skill monitoring guidance

- **WHEN** an operator reads host skill §4 / §4b follow or notify guidance
- **THEN** the text SHALL name the shared material filter (script, documented
  composition, or `logs … --material` equivalent)
- **AND** SHALL list or point to the material advance and loop event kinds

#### Scenario: Unfiltered evidence path remains available

- **WHEN** an operator needs full lifecycle detail rather than bubbles only
- **THEN** the guidance SHALL still allow unfiltered `logs … --events --follow`
  (or raw `events.jsonl`) as a diagnostic fallback
- **AND** SHALL NOT claim the material filter replaces the run store

---

### Requirement: Material filter guidance SHALL be consistent across host variants

All host skill variants that document long-running progress notify (at least `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the Grok-consumed path / `hosts/grok/SKILL.md` when present, plus generated plugin mirrors of those files) SHALL describe the **same** material kind set and spam-suppression rules for the events.jsonl material filter. Host variants SHALL differ only in the host notify map tool names used to surface filter output, not in which event kinds are material.

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
