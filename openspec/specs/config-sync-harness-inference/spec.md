# config-sync-harness-inference Specification

## Purpose
Lets `pipeline config sync` add omitted required harness roles from explicit model evidence so a 1.38.x config can migrate without a hand edit.

## Requirements

### Requirement: Config sync SHALL proceed when the only validation errors are omitted required harness roles

`pipeline config sync` SHALL continue into harness-role inference when `.github/pipeline.yml` exists and every `severity: "error"` diagnostic is the omitted-role class: the `harnesses` block is absent, or `harnesses.implementer` is omitted, or `harnesses.reviewer` is omitted. `pipeline config sync` SHALL still fail closed, write nothing, and skip inference when any other error is present, including invalid YAML, an unknown key, a schema type error, an empty-string role, an unknown key inside `harnesses`, or a conflicting `review_harness` command against a declared `harnesses.reviewer`. `pipeline config validate` SHALL continue to report omitted roles as errors. Every command other than `config sync` that resolves execution configuration SHALL remain fail-closed on omitted roles.

#### Scenario: Omitted harnesses block with no other errors reaches inference

- **WHEN** `.github/pipeline.yml` exists with no `harnesses:` block and no other validation errors
- **AND** the user runs `pipeline config sync`
- **THEN** the command SHALL NOT block solely because those roles are omitted
- **AND** it SHALL run inference for the omitted roles

#### Scenario: Unknown key still blocks sync

- **WHEN** `.github/pipeline.yml` omits `harnesses:` and also sets an unknown top-level key
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL fail closed
- **AND** the file SHALL remain unchanged

#### Scenario: Invalid YAML still blocks sync

- **WHEN** `.github/pipeline.yml` is not valid YAML
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL fail closed
- **AND** the file SHALL remain unchanged

#### Scenario: Config validate stays fail-closed

- **WHEN** `.github/pipeline.yml` exists with no `harnesses:` block
- **AND** the user runs `pipeline config validate`
- **THEN** the command SHALL exit 1
- **AND** diagnostics SHALL include an error naming `harnesses.implementer` and `harnesses.reviewer`

#### Scenario: Status and doctor stay fail-closed

- **WHEN** `.github/pipeline.yml` exists with no `harnesses:` block
- **AND** the user runs `pipeline status` or `pipeline doctor`
- **THEN** that command SHALL fail closed before work
- **AND** it SHALL NOT infer or write harness roles

### Requirement: Config sync SHALL infer omitted roles from a closed migration-only alias table

`pipeline config sync` SHALL classify explicit model aliases through a closed, versioned, migration-only alias table. The table SHALL map recognized Claude aliases to `claude`, recognized Grok aliases to `grok`, and recognized Codex/OpenAI aliases to `codex`. Recognized Claude aliases SHALL include `sonnet`, `opus`, `haiku`, `claude-fable-5`, and any value that starts with `claude-`. Recognized Grok aliases SHALL include any value that starts with `grok-`. Recognized Codex/OpenAI aliases SHALL include any value that starts with `gpt-`. The sentinel `auto`, unknown aliases, OpenCode aliases, Pi aliases, and extension adapter names SHALL produce no inference. Inference SHALL NOT use the active host profile. A commented `# harnesses:` block SHALL NOT count as declared policy.

#### Scenario: Claude implementer aliases and a gpt review model infer claude and codex

- **WHEN** `.github/pipeline.yml` omits `harnesses:` and sets `models.planning`, `models.implementing`, and `models.fix` to `sonnet` and `models.review` to `gpt-5.6-terra`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.implementer: claude` and `harnesses.reviewer: codex`

#### Scenario: Grok implementer aliases infer grok

- **WHEN** `.github/pipeline.yml` omits `harnesses:` and sets `models.planning` to `grok-4.6` and `models.review` to `gpt-5.6-terra`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.implementer: grok` and `harnesses.reviewer: codex`

#### Scenario: Auto and unknown aliases do not infer

- **WHEN** `.github/pipeline.yml` omits `harnesses:` and sets every `models.*` field to `auto` or omits them
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL NOT fill either role from the active profile

#### Scenario: OpenCode, Pi, and unknown values do not infer

- **WHEN** `.github/pipeline.yml` omits `harnesses:` and sets `models.planning` to an OpenCode, Pi, extension, or unknown alias
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** implementer inference SHALL remain unresolved

#### Scenario: Commented harnesses block is omitted policy

- **WHEN** `.github/pipeline.yml` contains only a commented `# harnesses:` block and unambiguous classified `models:` evidence
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL infer the omitted roles from `models:`
- **AND** it SHALL NOT treat the comment as declared policy

### Requirement: Implementer inference SHALL require unanimous classified implementer model evidence

Implementer inference SHALL examine every explicitly configured `models.planning`, `models.implementing`, `models.fix`, `models.intake`, and `models.sweep` field. A missing implementer role SHALL require at least one classified non-`auto` value, and every explicit non-`auto` value for that role SHALL map to the same adapter. Absent fields and explicit `auto` SHALL be ignored. An empty or whitespace-only explicit value is unknown evidence, not an absent field. An unknown explicit non-`auto` value or two different classified adapters SHALL leave implementer unresolved.

#### Scenario: One classified implementer field is enough

- **WHEN** `.github/pipeline.yml` omits `harnesses.implementer` and sets only `models.planning: grok-4.6` among the implementer model fields
- **AND** reviewer evidence is classified
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.implementer: grok`

#### Scenario: Conflicting implementer models block inference

- **WHEN** `.github/pipeline.yml` omits `harnesses.implementer` and sets `models.planning: sonnet` and `models.implementing: grok-4.6`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL name `harnesses.implementer` as unresolved

#### Scenario: Unknown sibling blocks implementer inference

- **WHEN** `.github/pipeline.yml` omits `harnesses.implementer` and sets `models.planning: sonnet` and `models.fix` to an unknown alias
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL name `harnesses.implementer` as unresolved

#### Scenario: Empty explicit implementer model blocks inference

- **WHEN** `.github/pipeline.yml` omits `harnesses.implementer` and sets `models.planning: sonnet` and `models.fix` to an empty string
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL name `harnesses.implementer` as unresolved

### Requirement: Reviewer inference SHALL use models.review and explicit review_harness.command

Reviewer inference SHALL examine `models.review` and an explicit `review_harness.command` when present. An explicit `review_harness.command` of `claude`, `codex`, or `grok` SHALL be classified command evidence for that adapter. An explicit custom `review_harness.command` (any other non-empty string) SHALL satisfy the reviewer role as that command when no classified review-model evidence exists. Classified review-model evidence SHALL agree with classified command evidence. Custom command plus classified review-model evidence SHALL leave reviewer unresolved. A structured `review_harness.model` that is present and not `auto` SHALL classify the same way as `models.review` and SHALL agree with the inferred reviewer.

#### Scenario: Review model alone infers reviewer

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer`, has no `review_harness` key, and sets `models.review: gpt-5.6-terra`
- **AND** implementer evidence is classified
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.reviewer: codex`

#### Scenario: Explicit built-in review_harness.command infers that reviewer

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer` and sets `review_harness.command: codex` with no conflicting `models.review`
- **AND** implementer evidence is classified
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.reviewer: codex`

#### Scenario: Custom review_harness.command without a classified review model satisfies reviewer

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer` and sets `review_harness: my-reviewer` with no classified `models.review`
- **AND** implementer evidence is classified
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL contain `harnesses.reviewer: my-reviewer`

#### Scenario: Custom command plus classified review model is unresolved

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer` and sets `review_harness: my-reviewer` and `models.review: sonnet`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL name `harnesses.reviewer` as unresolved

#### Scenario: Built-in command disagrees with review model

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer` and sets `review_harness.command: codex` and `models.review: sonnet`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write nothing
- **AND** it SHALL name `harnesses.reviewer` as unresolved

### Requirement: Config sync SHALL preserve declared harness roles and infer only omitted roles

`pipeline config sync` SHALL keep every valid explicitly declared `harnesses.implementer` or `harnesses.reviewer` value and SHALL infer only omitted roles. Sync SHALL NOT overwrite a declared role from models, from `review_harness`, or from the active profile.

#### Scenario: Declared implementer is kept while reviewer is inferred

- **WHEN** `.github/pipeline.yml` sets `harnesses.implementer: grok`, omits `harnesses.reviewer`, and sets `models.review: gpt-5.6-terra`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the written file SHALL keep `harnesses.implementer: grok`
- **AND** it SHALL add `harnesses.reviewer: codex`

#### Scenario: Complete pair is not rewritten by inference

- **WHEN** `.github/pipeline.yml` already sets both `harnesses.implementer` and `harnesses.reviewer`
- **AND** the user runs `pipeline config sync --apply`
- **THEN** those two values SHALL remain the effective roles
- **AND** inference SHALL NOT replace them from `models:`

### Requirement: Config sync preview SHALL show the complete candidate and apply SHALL write only a fully validated candidate

`pipeline config sync` without `--apply` SHALL print the complete candidate that includes inferred harness roles and SHALL write nothing. `pipeline config sync --apply` SHALL write through the existing append-preserving sync path: a missing top-level `harnesses` block is appended; a partial `harnesses` block is completed by rewriting only that top-level block. Other top-level keys and operator comments SHALL remain unchanged. The candidate SHALL pass full configuration validation, including both required roles, before any write. Failed inference SHALL exit 2, write nothing, and name each unresolved role.

#### Scenario: Preview shows inferred harnesses and writes nothing

- **WHEN** inference succeeds for both omitted roles
- **AND** the user runs `pipeline config sync` without `--apply`
- **THEN** the output SHALL include the complete candidate containing both inferred roles
- **AND** the existing file SHALL remain unchanged
- **AND** the command SHALL exit 0

#### Scenario: Apply writes inferred harnesses after validation

- **WHEN** inference succeeds for omitted roles
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL write the candidate only after full validation succeeds
- **AND** it SHALL exit 0

#### Scenario: Failed inference exits 2 and names unresolved roles

- **WHEN** implementer evidence is conflicting and reviewer evidence is missing
- **AND** the user runs `pipeline config sync --apply`
- **THEN** the command SHALL exit 2
- **AND** diagnostics SHALL name `harnesses.implementer` and `harnesses.reviewer`
- **AND** the file SHALL remain unchanged

#### Scenario: Missing entire harnesses block is appended

- **WHEN** `.github/pipeline.yml` has no `harnesses:` key and inference succeeds
- **AND** the user runs `pipeline config sync --apply`
- **THEN** a `harnesses` block SHALL be appended
- **AND** other existing top-level keys and comments SHALL remain byte-identical
