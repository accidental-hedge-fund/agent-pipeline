## ADDED Requirements

### Requirement: Config SHALL accept an optional supersede_mode key

The pipeline configuration schema SHALL accept an optional `supersede_mode` key whose value is one of `close` or `comment-only`. When the key is omitted, the effective mode SHALL be `close`. Invalid values SHALL fail config validation. The key controls the supersede-stale-issue-prs action applied to non-managed open issue-linked PRs after managed PR create-or-reuse (`close` posts a structured comment and closes; `comment-only` posts the comment and leaves the PR open).

#### Scenario: omitted supersede_mode defaults to close

- **WHEN** `.github/pipeline.yml` does not set `supersede_mode`
- **AND** config is resolved successfully
- **THEN** the effective supersede mode SHALL be `close`

#### Scenario: comment-only is accepted

- **WHEN** `.github/pipeline.yml` sets `supersede_mode: comment-only`
- **AND** config is resolved successfully
- **THEN** the effective supersede mode SHALL be `comment-only`

#### Scenario: invalid supersede_mode fails validation

- **WHEN** `.github/pipeline.yml` sets `supersede_mode` to a value other than `close` or `comment-only`
- **THEN** config validation SHALL fail
