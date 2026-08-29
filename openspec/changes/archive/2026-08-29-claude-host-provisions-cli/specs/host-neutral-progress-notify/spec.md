## MODIFIED Requirements

### Requirement: Grok-consumed packaging SHALL not teach Claude-only PushNotification as required

The skill packaging path that Grok agents load (first-class `hosts/grok` when install supports it, or the installed/symlink path Grok actually uses plus an explicit Grok §4/§4b substitute) SHALL prescribe Grok's host `monitor` + material filter for progress notify. That path SHALL NOT instruct Grok agents that Claude `PushNotification` is required for material stage or loop bubbles. Coordination with first-class `--host grok` install (#731) is allowed; until that lands, the documented substitute on the path Grok consumes SHALL be sufficient.

#### Scenario: Grok path documents monitor + material filter

- **WHEN** a Grok agent follows installed skill guidance for `/pipeline` or
  `pipeline loop` progress notify
- **THEN** the guidance SHALL name host `monitor` (or Grok-equivalent) on a
  material-filtered event stream
- **AND** SHALL NOT state that `PushNotification` is required on Grok

#### Scenario: Symlink or Claude overlay consumers get an explicit Grok substitute when no hosts/grok exists

- **WHEN** Grok still installs or symlinks the Claude skill file because
  first-class `--host grok` is unavailable
- **THEN** that consumed file or an immediately adjacent Grok substitute
  section SHALL override Claude-only notify for Grok hosts
- **AND** SHALL name the material filter composition
