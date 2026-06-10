## MODIFIED Requirements

### Requirement: Dependency relevance filtering
The installer SHALL determine which external dependencies are relevant for the current install based on feature flags in `.github/pipeline.yml`. It SHALL NOT prompt for companion plugins (`cc-plugin-codex`, `codex-plugin-cc`) — review runs via `prompt-harness` (direct CLI invocation) and requires no companion plugin. It SHALL NOT prompt for dependencies that are not relevant to the chosen configuration.

Relevance rules:
- `openspec` CLI: relevant when `openspec.enabled` is `on`/`true` in `.github/pipeline.yml`, or when it is `auto`/absent and the target repo has an `openspec/` directory.
- `last30days` skill: relevant when `last30days.enabled: true` in `.github/pipeline.yml`.

#### Scenario: Companion plugins are never prompted
- **WHEN** the installer runs for any host configuration
- **THEN** `cc-plugin-codex` and `codex-plugin-cc` SHALL NOT appear in the dependency prompt list

#### Scenario: Feature flag gates last30days prompt
- **WHEN** `.github/pipeline.yml` exists and `last30days.enabled` is absent or false
- **THEN** the installer does not prompt for the `last30days` skill

#### Scenario: Feature flag enables last30days prompt
- **WHEN** `.github/pipeline.yml` has `last30days.enabled: true`
- **THEN** `last30days` is included in the dependency prompt list
