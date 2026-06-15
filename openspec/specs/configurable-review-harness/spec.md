# configurable-review-harness Specification

## Purpose
TBD - created by archiving change configurable-review-harness. Update Purpose after archive.
## Requirements
### Requirement: review_harness config key overrides the profile reviewer
`PartialConfigSchema` SHALL accept an optional `review_harness` key of type `string`. When present, `resolveConfig()` SHALL use the value as `cfg.harnesses.reviewer` in place of the profile's default reviewer harness, applied after the profile/file/CLI merge step. The `harnesses:` block SHALL remain absent from `PartialConfigSchema` and SHALL continue to be rejected by strict validation. When `review_harness` is absent, the profile's reviewer is used unchanged.

#### Scenario: review_harness key present
- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"` regardless of the profile's default reviewer

#### Scenario: review_harness key absent
- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL equal the profile's default reviewer harness with no warning or change in behavior

#### Scenario: review_harness key absent under claude profile
- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` (the profile's cross-harness default)

### Requirement: invoke() accepts an arbitrary string harness name
`invoke()` SHALL accept a `string` for the `harness` parameter. For `"claude"` and `"codex"`, the invocation shapes are unchanged. For any other string value, `invoke()` SHALL spawn the CLI named by the string with the prompt as a positional argument, capture its stdout as the harness output, and surface a specific failure message when the CLI cannot be spawned.

#### Scenario: built-in claude harness invocation unchanged
- **WHEN** `invoke("claude", ...)` is called
- **THEN** the `claude` CLI SHALL be invoked with `--print --permission-mode bypassPermissions --output-format text` flags, as before this change

#### Scenario: built-in codex harness invocation unchanged
- **WHEN** `invoke("codex", ...)` is called
- **THEN** the `codex` CLI SHALL be invoked with `exec --full-auto -C <worktreeDir>` flags, as before this change

#### Scenario: custom harness string is spawned with prompt as argument
- **WHEN** `invoke("my-reviewer", worktreeDir, prompt, opts)` is called
- **THEN** `my-reviewer` SHALL be spawned with the prompt as a positional argument and its stdout SHALL be returned as the harness output

### Requirement: Configured reviewer CLI unavailability fails with a specific, actionable message
When the configured reviewer CLI (from `cfg.harnesses.reviewer`) cannot be spawned — because it is not found on PATH, lacks execute permission, or exits immediately with a spawn error — `invoke()` SHALL surface an error message that names the CLI explicitly (e.g. `reviewer CLI 'my-reviewer' not found or not executable — ensure it is installed and on PATH`) rather than throwing `"Unknown harness"`. The `invokeReviewer` self-review fallback (established by #39) SHALL apply: the implementing harness is tried next; if it also fails, the item is blocked with an error naming both the configured reviewer and the fallback.

#### Scenario: configured reviewer not on PATH
- **WHEN** `cfg.harnesses.reviewer` names a CLI that is not installed
- **THEN** the error message surfaced SHALL name the CLI explicitly and SHALL NOT read only `"Unknown harness"`
- **AND** the `invokeReviewer` self-review fallback SHALL be attempted with the implementing harness

#### Scenario: both configured reviewer and self-review fallback fail
- **WHEN** the configured reviewer is not spawnable AND the implementing harness is also not spawnable
- **THEN** the item SHALL be blocked with an error message that names both the configured reviewer and the fallback harness

