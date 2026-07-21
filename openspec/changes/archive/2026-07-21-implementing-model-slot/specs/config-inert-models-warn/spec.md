## MODIFIED Requirements

### Requirement: Warn when models.implementing is set but the implementer harness is codex

`resolveConfig()` SHALL emit a `console.warn` when `models.implementing` is explicitly set in the file config (`fileConfig.models?.implementing` is not `undefined`) and the active profile has `harnesses.implementer === "codex"`. The warning SHALL follow the same format as the existing `models.planning` and `models.fix` warnings: naming the key (`models.implementing`), its configured value, the affected role (`implementer`), the backing harness (`codex`), and the reason the setting is ignored.

#### Scenario: models.implementing set with implementer=codex warns

- **WHEN** `.github/pipeline.yml` sets `models.implementing` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.implementing`, the configured value, the word `codex`, and an indication that the alias is ignored

#### Scenario: models.implementing set with implementer=claude — no warning

- **WHEN** `.github/pipeline.yml` sets `models.implementing` and the active profile has `harnesses.implementer === "claude"`
- **THEN** `resolveConfig()` SHALL NOT emit any warning for `models.implementing`

#### Scenario: models.implementing absent — no warning even if implementer=codex

- **WHEN** `.github/pipeline.yml` does not set `models.implementing` and the implementer harness is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit a warning for `models.implementing` (default-valued keys never warn)
