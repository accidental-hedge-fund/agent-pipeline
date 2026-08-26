## MODIFIED Requirements

### Requirement: review_harness config key overrides the profile reviewer

`PartialConfigSchema` SHALL accept an optional `review_harness` key that is either a bare `string` (the command shorthand) or a strict object `{ command: string, model?: string | "auto", effort?: string | "auto" }`. `review_harness` SHALL be a structured overlay on the required repository `harnesses.reviewer` key. It SHALL NOT replace `harnesses.reviewer` and SHALL NOT take the live reviewer from the active profile.

When `review_harness` is present in either form and `harnesses.reviewer` is absent, execution-policy resolution SHALL fail closed. When both are present they SHALL agree: naming the same command is accepted and the structured `review_harness` model/effort/prompt-delivery settings continue to apply, while naming different commands SHALL be rejected with a message naming both keys and both values rather than silently selecting one. For the object form, `resolveConfig()` SHALL set `cfg.harnesses.reviewerModel` from `model` and `cfg.harnesses.reviewerEffort` from `effort`; for the string form, both SHALL remain unset. When `review_harness` is absent and `harnesses.reviewer` is present, the live reviewer SHALL be `harnesses.reviewer` and `reviewerModel`/`reviewerEffort` SHALL remain unset.

`PartialConfigSchema` SHALL continue to accept the strict repository `harnesses` role block (see `configurable-harness-roles`); a key inside it other than `implementer` or `reviewer` SHALL still be rejected by strict validation.

#### Scenario: review_harness string form present

- **WHEN** `.github/pipeline.yml` sets `harnesses.reviewer: my-reviewer` and `review_harness: my-reviewer` and also declares `harnesses.implementer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"`, and `cfg.harnesses.reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness object form present

- **WHEN** `.github/pipeline.yml` sets `harnesses.reviewer: claude` and `review_harness: { command: claude, model: claude-fable-5, effort: max }` and also declares `harnesses.implementer`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"max"`

#### Scenario: review_harness key absent

- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key and no `harnesses` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.reviewer` SHALL NOT equal the profile's default reviewer harness

#### Scenario: review_harness key absent under claude profile

- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key and no `harnesses` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.reviewer` SHALL NOT be `"codex"` by profile default

#### Scenario: harnesses.reviewer supplies the reviewer when review_harness is absent

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: agreeing review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and `review_harness: { command: codex, model: gpt-5.6-terra }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `cfg.harnesses.reviewerModel` SHALL be `"gpt-5.6-terra"`

#### Scenario: conflicting review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { reviewer: codex }` and `review_harness: claude`
- **THEN** `resolveConfig()` SHALL fail with a message naming both keys and both values, and no stage SHALL run

#### Scenario: review_harness without harnesses.reviewer fails closed

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and no `harnesses` block
- **THEN** execution-policy resolution SHALL fail with a diagnostic naming `harnesses.reviewer`
