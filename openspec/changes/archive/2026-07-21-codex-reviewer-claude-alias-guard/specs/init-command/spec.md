## ADDED Requirements

### Requirement: The scaffolded `models:` comment SHALL document the post-passthrough reviewer contract

The `.github/pipeline.yml` scaffold written by `init` (and used as the structural baseline by `config sync`) SHALL describe the current reviewer-model contract: the `review` alias is passed
through to both built-in reviewer harnesses (`claude` via `--model`, `codex` via
`codex exec -m`), and a Claude-only alias configured against a codex reviewer is rejected at
config-parse time. The comment SHALL NOT state that codex ignores the reviewer alias or that
setting it merely prints a warning. The implementer-role keys
(`planning`/`implementing`/`fix`) SHALL continue to be documented as inert on a codex
implementer.

#### Scenario: Freshly scaffolded config documents the current contract

- **WHEN** `pipeline init` scaffolds `.github/pipeline.yml` in a repo with no existing config
- **THEN** the `models:` comment SHALL state that `review` is honored by both built-in reviewer harnesses
- **AND** it SHALL state that a Claude alias (`sonnet`/`opus`/`haiku`/`claude-*`) with a codex reviewer is a config error
- **AND** it SHALL NOT claim the reviewer alias is ignored by codex

#### Scenario: config sync refreshes an existing file to the corrected comment

- **WHEN** `config sync` is applied to a valid existing `.github/pipeline.yml` carrying the pre-passthrough `models:` comment
- **THEN** the refreshed file SHALL carry the corrected comment text
- **AND** the file's explicitly configured values SHALL be preserved unchanged
