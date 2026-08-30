## MODIFIED Requirements

### Requirement: Generated hosts SHALL share one compact event-follow contract

`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` SHALL be byte-identical generated one-pagers containing the same retained `loop_run_id` and linked `advance_run_id` event-follow commands, material-filter obligation, durable-doc pointer, premature-exit failure/recovery rule, and compact host-notify map. Material-event membership and spam suppression SHALL come from the shared filter, while the active host selects only its notify-map row. No generated surface SHALL carry the broad stdout alternation or a host-specific material-kind inventory. The generator SHALL NOT write a plugin SKILL overlay to carry this contract.

#### Scenario: Claude host filter matches spec

- **WHEN** `hosts/claude/SKILL.md` is read
- **THEN** it SHALL carry the shared compact event-follow and material-filter contract
- **AND** it SHALL NOT carry a Claude-specific event inventory or broad stdout filter

#### Scenario: Codex host filter matches spec

- **WHEN** `hosts/codex/SKILL.md` is read
- **THEN** its follow/filter bytes SHALL match the generated Claude one-pager
- **AND** only runtime selection of the Codex notify-map row SHALL differ

#### Scenario: Plugin SKILL.md filter matches spec

- **WHEN** `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** the four generated host SKILLs SHALL remain the compact filter surfaces
- **AND** no plugin overlay SHALL restore the retired per-host filter essay
