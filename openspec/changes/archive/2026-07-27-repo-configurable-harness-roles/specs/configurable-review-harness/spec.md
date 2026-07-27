## MODIFIED Requirements

### Requirement: review_harness config key overrides the profile reviewer

`PartialConfigSchema` SHALL accept an optional `review_harness` key that is either a bare `string` (the command shorthand) or a strict object `{ command: string, model?: string | "auto", effort?: string | "auto" }`. When present in either form, `resolveConfig()` SHALL use the command as `cfg.harnesses.reviewer` in place of the profile's default reviewer harness, applied after the profile/file/CLI merge step. For the object form, `resolveConfig()` SHALL additionally set `cfg.harnesses.reviewerModel` from `model` and `cfg.harnesses.reviewerEffort` from `effort`; for the string form, both SHALL remain unset. When `review_harness` is absent, the reviewer resolves from the repository `harnesses.reviewer` key when present and otherwise from the profile, and `reviewerModel`/`reviewerEffort` SHALL remain unset.

`PartialConfigSchema` SHALL also accept the strict repository `harnesses` role block (see `configurable-harness-roles`); a `harnesses:` block is no longer rejected outright, though a key inside it other than `implementer` or `reviewer` SHALL still be rejected by strict validation. When both `review_harness` and `harnesses.reviewer` are present, they SHALL agree: naming the same command is accepted and the structured `review_harness` model/effort/prompt-delivery settings continue to apply, while naming different commands SHALL be rejected with a message naming both keys and both values rather than silently selecting one.

#### Scenario: review_harness string form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"` regardless of the profile's default reviewer, and `cfg.harnesses.reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness object form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: claude, model: claude-fable-5, effort: max }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"max"`

#### Scenario: review_harness key absent

- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key and no `harnesses` block
- **THEN** `cfg.harnesses.reviewer` SHALL equal the profile's default reviewer harness with no warning or change in behavior, and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness key absent under claude profile

- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key and no `harnesses` block
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` (the profile's cross-harness default)

#### Scenario: harnesses.reviewer supplies the reviewer when review_harness is absent

- **WHEN** `.github/pipeline.yml` sets `harnesses: { reviewer: codex }` and no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: agreeing review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { reviewer: codex }` and `review_harness: { command: codex, model: gpt-5.6-terra }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `cfg.harnesses.reviewerModel` SHALL be `"gpt-5.6-terra"`

#### Scenario: conflicting review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { reviewer: codex }` and `review_harness: claude`
- **THEN** `resolveConfig()` SHALL fail with a message naming both keys and both values, and no stage SHALL run

### Requirement: Reviewer model and effort SHALL resolve round-aware from reviewer overrides then config fallback

The review routing SHALL pass the reviewer model as `cfg.harnesses.reviewerModel ?? cfg.models.review` and the reviewer effort as `cfg.harnesses.reviewerEffort ?? cfg.effort.review` to each `invokeReviewer` call. When either resolved value is `"auto"`, it SHALL be resolved using the classification of the concrete review round: `review-1` as Adversarial/Iterative and `review-2` as Adversarial/Definitive. The plan-review round SHALL resolve `auto` as Adversarial/Definitive.

The resolved reviewer **model** SHALL be validated against the effective reviewer command before it reaches the harness invocation: when the resolved model is an alias the effective reviewer harness cannot run — determined from that harness adapter's capabilities and recognized aliases rather than a hard-coded pair of harness names, e.g. a claude-only alias such as `claude-fable-5`, `sonnet`, or `opus` reaching a `codex` reviewer — the review routing SHALL pass no model to the invocation (so the reviewer CLI receives no model flag and uses its configured default) rather than forwarding the unrunnable alias. An explicit (non-`auto`) reviewer model SHALL be forwarded verbatim to the reviewer command regardless of harness.

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

#### Scenario: codex reviewer with auto model resolves to no model flag

- **WHEN** the effective reviewer command is `codex` and the resolved reviewer model comes from the `"auto"` sentinel (which yields the claude-only alias `claude-fable-5` for every Adversarial round)
- **THEN** review routing SHALL NOT forward a claude-only alias to codex
- **AND** the `codex exec` invocation SHALL omit the `-m` flag

#### Scenario: codex reviewer configured through the harnesses block behaves identically

- **WHEN** the reviewer is resolved from `harnesses: { reviewer: codex }` rather than `review_harness`, and `models.review` is `"auto"`
- **THEN** review routing SHALL NOT forward a claude-only alias to codex
- **AND** the `codex exec` invocation SHALL omit the `-m` flag

#### Scenario: codex reviewer with an explicit model forwards it verbatim

- **WHEN** `review_harness: { command: codex, model: gpt-5.6-terra }` is set
- **THEN** review routing SHALL pass model `"gpt-5.6-terra"` to `invokeReviewer`
- **AND** the `codex exec` invocation SHALL include `-m gpt-5.6-terra`
