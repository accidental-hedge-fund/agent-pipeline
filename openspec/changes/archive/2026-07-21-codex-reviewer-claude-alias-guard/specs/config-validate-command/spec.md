## ADDED Requirements

### Requirement: A Claude-only reviewer model alias against a codex reviewer SHALL be a validation error, not a warning

`validateConfig()` SHALL classify an explicitly configured Claude-only reviewer model alias
(`models.review` or `review_harness.model`) as severity `error` when the effective reviewer
harness is `codex`, so `pipeline config validate` exits 1. It SHALL NOT additionally report the
same key as an inert-setting `warning`, which would contradict the error. The diagnostic
message SHALL match the parse-time rejection: key path, rejected value, reviewer harness, and
the valid alternatives (an account-supported OpenAI model id, or `auto`).

#### Scenario: models.review Claude alias with a codex reviewer exits 1

- **WHEN** `pipeline config validate` runs against a config setting `models: { review: sonnet }` with an effective codex reviewer
- **THEN** the diagnostics SHALL include one with `severity: "error"` and `path: "models.review"`
- **AND** the command SHALL exit 1
- **AND** no `warning` diagnostic SHALL be reported for `models.review`

#### Scenario: review_harness.model Claude alias with a codex reviewer exits 1

- **WHEN** `pipeline config validate` runs against a config setting `review_harness: { command: codex, model: haiku }`
- **THEN** the diagnostics SHALL include one with `severity: "error"` and `path: "review_harness.model"`
- **AND** the command SHALL exit 1

#### Scenario: auto reviewer model produces no diagnostic

- **WHEN** `pipeline config validate` runs against a config setting `models: { review: auto }` with an effective codex reviewer
- **THEN** no diagnostic SHALL be reported for `models.review`
- **AND** the command SHALL exit 0

#### Scenario: validateConfig never throws on the rejected alias

- **WHEN** `validateConfig()` is called on a config containing a Claude-only reviewer alias with a codex reviewer
- **THEN** it SHALL return `{ valid: false, diagnostics }` rather than throwing
