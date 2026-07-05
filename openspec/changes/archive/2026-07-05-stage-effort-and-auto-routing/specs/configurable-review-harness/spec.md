## MODIFIED Requirements

### Requirement: review_harness config key overrides the profile reviewer

`PartialConfigSchema` SHALL accept an optional `review_harness` key that is either a bare `string` (the command shorthand) or a strict object `{ command: string, model?: string | "auto", effort?: string | "auto" }`. When present in either form, `resolveConfig()` SHALL use the command as `cfg.harnesses.reviewer` in place of the profile's default reviewer harness, applied after the profile/file/CLI merge step. For the object form, `resolveConfig()` SHALL additionally set `cfg.harnesses.reviewerModel` from `model` and `cfg.harnesses.reviewerEffort` from `effort`; for the string form, both SHALL remain unset. The `harnesses:` block SHALL remain absent from `PartialConfigSchema` and SHALL continue to be rejected by strict validation. When `review_harness` is absent, the profile's reviewer is used unchanged and `reviewerModel`/`reviewerEffort` are unset.

#### Scenario: review_harness string form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"` regardless of the profile's default reviewer, and `cfg.harnesses.reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness object form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: claude, model: claude-fable-5, effort: max }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"max"`

#### Scenario: review_harness key absent

- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL equal the profile's default reviewer harness with no warning or change in behavior, and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness key absent under claude profile

- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` (the profile's cross-harness default)

## ADDED Requirements

### Requirement: Reviewer model and effort SHALL resolve round-aware from reviewer overrides then config fallback

The review routing SHALL pass the reviewer model as `cfg.harnesses.reviewerModel ?? cfg.models.review` and the reviewer effort as `cfg.harnesses.reviewerEffort ?? cfg.effort.review` to each `invokeReviewer` call. When either resolved value is `"auto"`, it SHALL be resolved using the classification of the concrete review round: `review-1` as Adversarial/Iterative and `review-2` as Adversarial/Definitive. The plan-review round SHALL resolve `auto` as Adversarial/Definitive.

#### Scenario: reviewer override wins over config fallback

- **WHEN** `review_harness: { command: claude, model: opus }` is set and `models.review` is `"sonnet"`
- **THEN** review routing SHALL pass model `"opus"` to `invokeReviewer` (the reviewer override wins)

#### Scenario: reviewer auto is round-aware

- **WHEN** `review_harness: { command: claude, model: auto, effort: auto }` is set
- **THEN** `review-1` SHALL resolve to model `"claude-fable-5"` / effort `"high"` (Iterative)
- **AND** `review-2` SHALL resolve to model `"claude-fable-5"` / effort `"max"` (Definitive)

#### Scenario: config fallback when reviewer overrides absent

- **WHEN** `review_harness: claude` (string form) is set and `effort: { review: high }` is configured
- **THEN** review routing SHALL pass effort `"high"` from `cfg.effort.review` (the config fallback)
