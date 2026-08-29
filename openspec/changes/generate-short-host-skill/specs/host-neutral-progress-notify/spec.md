## MODIFIED Requirements

### Requirement: Host skill overlays SHALL document a host notify map for material progress

The shared orchestration-contract source SHALL document a **host notify map** that names how each SKILL host surfaces material progress. Generated SKILLs MAY substitute only that host's notify-tool names. The map SHALL include at least:

- **Claude:** Monitor (or equivalent follow) on the material event stream, plus `PushNotification` (or successor Claude push surface) for material one-liners.
- **Grok:** host `monitor` (or equivalent) on the material event stream such that each material stdout line becomes a chat notification; Grok packaging SHALL NOT hard-require Claude `PushNotification`.
- **Codex:** concise chat/status updates on material events; Codex packaging SHALL NOT name Claude-only tools as required.
- **OpenCode:** the host's documented equivalent notify surface, not a Claude-only tool.

The shared contract SHALL state that the harness **must notify via the host map** on material events. The follower SHALL NOT invoke a merge-capable command as a notify side effect.

#### Scenario: Claude map names PushNotification for that host only

- **WHEN** an operator reads the generated Claude SKILL or the shared contract
- **THEN** the Claude entry SHALL name Monitor follow plus `PushNotification` (or documented Claude successor) for material progress
- **AND** the shared mandatory step language SHALL be notify-via-host-map rather than implying every host has `PushNotification`

#### Scenario: Grok map never requires PushNotification

- **WHEN** an operator or agent reads the generated Grok SKILL
- **THEN** the text SHALL name host `monitor` (or equivalent) with material-only lines as the notify surface
- **AND** SHALL NOT hard-require Claude `PushNotification` for Grok

#### Scenario: Codex map uses chat/status without Claude tool names

- **WHEN** an operator reads the generated Codex SKILL
- **THEN** the Codex entry SHALL require concise chat or status updates for material events
- **AND** SHALL NOT list `PushNotification` as a required tool
