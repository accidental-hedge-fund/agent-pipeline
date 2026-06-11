## ADDED Requirements

### Requirement: Inert models.* aliases produce a diagnostic warning at config-resolve time
`resolveConfig()` SHALL detect and warn about `models.*` aliases that are explicitly set in `.github/pipeline.yml` but will be silently ignored because the backing harness role is `codex`. This requirement augments the existing config-loading contract without changing validation, precedence, or the never-auto-merge safety floor. See the `config-inert-models-warn` capability for full requirements and scenarios.

#### Scenario: explicit inert alias detected and warned
- **WHEN** `.github/pipeline.yml` explicitly sets one or more `models.*` keys and the backing harness role for each is `codex`
- **THEN** `resolveConfig()` SHALL emit a non-blocking `console.warn` for each affected key before returning the resolved config
