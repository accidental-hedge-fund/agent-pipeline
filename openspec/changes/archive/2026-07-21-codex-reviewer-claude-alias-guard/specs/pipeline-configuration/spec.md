## ADDED Requirements

### Requirement: Claude-only reviewer model aliases SHALL be rejected at config-parse time when the reviewer harness is codex

`resolveConfig()` SHALL reject, at config-parse time, an explicitly configured reviewer model
value that is a Claude-only model alias when the effective reviewer harness is `codex`. The
Claude-only set SHALL be the engine's existing single source of truth (`isClaudeOnlyModelAlias`:
`sonnet`, `opus`, `haiku`, `claude-fable-5`, or any id beginning with `claude-`). Both reviewer
model sources SHALL be covered: `models.review` and the structured `review_harness.model`. The
rejection SHALL happen before any stage runs, never as a mid-run reviewer-CLI failure.

#### Scenario: models.review set to a Claude alias with a codex reviewer is rejected

- **WHEN** `.github/pipeline.yml` sets `models: { review: sonnet }` and the effective reviewer harness is `codex`
- **THEN** `resolveConfig()` SHALL throw a config error
- **AND** no stage SHALL be invoked with that model

#### Scenario: review_harness.model set to a Claude alias with a codex reviewer is rejected

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: codex, model: opus }`
- **THEN** `resolveConfig()` SHALL throw a config error identifying `review_harness.model`

#### Scenario: A claude-prefixed model id is rejected for a codex reviewer

- **WHEN** `.github/pipeline.yml` sets `models: { review: claude-fable-5 }` and the effective reviewer harness is `codex`
- **THEN** `resolveConfig()` SHALL throw a config error

### Requirement: The rejection message SHALL name the key, value, harness, and the valid alternatives

The error raised for a rejected reviewer model alias SHALL name the offending config key path,
the rejected value, and the reviewer harness, and SHALL state what is valid for a codex
reviewer: an OpenAI model id the account supports (for example `gpt-5.6-terra` or the
`gpt-5.x-codex` family), or `auto` — identified as the safe choice because it resolves
round-aware and falls back to the operator's `~/.codex/config.toml` default.

#### Scenario: Error text is actionable

- **WHEN** `resolveConfig()` rejects `models: { review: sonnet }` against a codex reviewer
- **THEN** the error message SHALL contain the key path `models.review`, the value `sonnet`, and the harness name `codex`
- **AND** it SHALL name both an account-supported OpenAI model id and `auto` as valid replacements

### Requirement: Accepted reviewer model values SHALL be unaffected by the guard

The guard SHALL narrow nothing beyond the Claude-only alias / codex-reviewer combination.
`auto`, an absent `models.review` key, and any non-Claude model id SHALL resolve exactly as
before, and a reviewer harness other than `codex` SHALL be unaffected.

#### Scenario: auto is accepted for a codex reviewer

- **WHEN** `.github/pipeline.yml` sets `models: { review: auto }` and the effective reviewer harness is `codex`
- **THEN** `resolveConfig()` SHALL return a valid config with no error and no inert-alias warning for `models.review`

#### Scenario: An explicit codex-plausible model is accepted and preserved

- **WHEN** `.github/pipeline.yml` sets `models: { review: gpt-5.6-terra }` and the effective reviewer harness is `codex`
- **THEN** `resolveConfig()` SHALL return a valid config whose `models.review` is `gpt-5.6-terra`

#### Scenario: A Claude alias with a claude reviewer is accepted

- **WHEN** `.github/pipeline.yml` sets `models: { review: sonnet }` and the effective reviewer harness is `claude`
- **THEN** `resolveConfig()` SHALL return a valid config with `models.review` set to `sonnet` and SHALL NOT throw

#### Scenario: No models block is unaffected

- **WHEN** `.github/pipeline.yml` has no `models:` block and the effective reviewer harness is `codex`
- **THEN** `resolveConfig()` SHALL return a valid config and SHALL NOT throw

### Requirement: Tolerant callers SHALL degrade rather than throw on a rejected reviewer alias

When `resolveConfig()` is called with `tolerateInvalidConfig` (as `init` does), a rejected reviewer model alias SHALL be reported as a warning and the affected setting SHALL fall back to
defaults instead of throwing, matching the existing behavior for stage-executor validation
errors. When `quiet` is set, no warning SHALL be written to stderr.

#### Scenario: init tolerates a rejected reviewer alias

- **WHEN** `resolveConfig({ tolerateInvalidConfig: true })` reads a config with `models: { review: sonnet }` and a codex reviewer
- **THEN** it SHALL NOT throw
- **AND** it SHALL emit a warning naming the offending key and fall back to the default reviewer model
