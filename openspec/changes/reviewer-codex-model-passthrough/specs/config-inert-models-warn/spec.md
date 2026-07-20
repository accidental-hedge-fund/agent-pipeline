## RENAMED Requirements

- FROM: `### Requirement: Warn when a models.* alias is explicitly set but the backing harness role is codex`
- TO: `### Requirement: Warn when a models.* alias is explicitly set but its backing harness ignores model aliases`

## MODIFIED Requirements

### Requirement: Warn when a models.* alias is explicitly set but its backing harness ignores model aliases

`resolveConfig()` SHALL emit a `console.warn` for each `models.*` key that is (a) explicitly present in the file config (`fileConfig.models?.<key>` is not `undefined`) and (b) backed by a harness that ignores model aliases for that key. A harness ignores a model alias when:

- for an **implementer-role** key (`models.planning`, `models.implementing`, `models.fix`), the implementer harness is `codex` (implementer model passthrough is not implemented — those aliases remain inert); and
- for the **reviewer-role** key (`models.review`), the effective reviewer command is a **custom** reviewer CLI — i.e. neither `claude` nor `codex`. The reviewer role SHALL NOT warn when the reviewer command is `codex`, because the codex reviewer now honors the model via `codex exec -m <model>`, nor when it is `claude`.

The warning SHALL name the key, its value, the affected harness/reviewer, and the reason the setting is ignored. The warning SHALL NOT throw, mutate the resolved config, or trigger a fallback.

#### Scenario: models.review set with reviewer=codex — no warning

- **WHEN** `.github/pipeline.yml` sets `models.review` and the effective reviewer command is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-alias warning for `models.review` (the codex reviewer honors `-m <model>`)

#### Scenario: models.review set with a custom reviewer CLI warns

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and `models.review`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` naming `models.review`, the configured value, the reviewer command `my-reviewer`, and an indication that the alias is ignored

#### Scenario: models.planning set with implementer=codex warns

- **WHEN** `.github/pipeline.yml` sets `models.planning` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.planning`, the configured value, the word `codex`, and an indication that the alias is ignored

#### Scenario: models.fix set with implementer=codex warns

- **WHEN** `.github/pipeline.yml` sets `models.fix` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.fix`, the configured value, the word `codex`, and an indication that the alias is ignored
