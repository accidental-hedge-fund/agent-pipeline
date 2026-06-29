## ADDED Requirements

### Requirement: Factory scoreboard reports prompt-size telemetry

When stage accounting records contain prompt-size telemetry, the factory scoreboard SHALL aggregate and report it alongside existing stage accounting groups. JSON output SHALL expose total and maximum prompt size per accounting group. Human output SHALL include prompt-size columns or labels in the stage accounting section.

#### Scenario: JSON accounting groups include prompt totals
- **WHEN** `pipeline scoreboard --json` reads stage accounting records with `prompt_chars` and `prompt_estimated_tokens`
- **THEN** each affected accounting group SHALL include total prompt chars, maximum prompt chars, and total estimated prompt tokens

#### Scenario: Human accounting output includes prompt size
- **WHEN** `pipeline scoreboard` prints the stage accounting section
- **AND** included records contain prompt-size telemetry
- **THEN** the section SHALL display prompt-size values so operators can compare slow stages against prompt bulk
