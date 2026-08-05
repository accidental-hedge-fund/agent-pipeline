## ADDED Requirements

### Requirement: Material-progress notify mapping SHALL be declared on the outer-host manifest

The host notify map for material stage/loop progress SHALL be represented as the outer-host
manifest's material-progress notification capability (or an equivalent field consumed from that
manifest). Shared orchestration SHALL select the notify surface from the active outer host's
declared mapping or its declared unsupported fallback, not by host-name conditionals in shared
orchestration modules.

Existing host-specific surfaces (Claude Monitor + PushNotification, Grok monitor material lines,
Codex chat/status) remain valid **values** of the declared mapping; they MUST NOT be the only
extension mechanism via shared `if host == …` branches.

#### Scenario: Shared orchestration reads notify capability from the manifest

- **WHEN** shared advance or loop orchestration requires material progress notification
- **THEN** it SHALL use the active outer host's declared material-progress notify mapping or
  fallback
- **AND** SHALL NOT require editing shared orchestration host-name switches to support a new
  host's notify surface

#### Scenario: Host without rich notify uses portable fallback

- **WHEN** an outer host declares material-progress notify unsupported or limited to portable
  observation
- **THEN** the declared fallback SHALL use stdout and/or filtered `events.jsonl` material lines
- **AND** shared orchestration SHALL NOT hard-require Claude `PushNotification` for that host
