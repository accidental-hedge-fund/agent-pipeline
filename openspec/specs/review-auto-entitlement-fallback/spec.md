# review-auto-entitlement-fallback Specification

## Purpose
Defines how auto-selected Claude reviewer models recover from Fable/usage-credit entitlement failures, how those failures are classified for durable recovery, and how completed planning and design decision records are preserved when only the reviewer stage cannot start.
## Requirements
### Requirement: Auto-selected Claude reviewer models SHALL allowlist-retry once on entitlement 429

When the effective reviewer harness is `claude` and the reviewer model for the round originated from the `"auto"` sentinel (including unstructured `models.review: auto` and structured `review_harness.model: auto`), and the harness returns a **deterministic entitlement-specific failure** for the preferred auto model (usage-credit / Fable-requires-credits class, including the observed zero-token HTTP 429), the pipeline SHALL perform **exactly one** in-process retry of the same reviewer prompt with the allowlisted subscription-backed model `sonnet` (same stage and effort selection as the original attempt). The pipeline SHALL NOT rely on the Claude CLI `--fallback-model` flag as the recovery mechanism for this failure class.

#### Scenario: Zero-token Fable entitlement recovers via sonnet under auto

- **WHEN** `models.review` is `"auto"`, the reviewer harness is `claude`, the first invoke requests `claude-fable-5`, and Claude returns the usage-credit entitlement 429 with zero tokens
- **THEN** the pipeline SHALL retry the same reviewer call once with model `sonnet`
- **AND** when the sonnet attempt succeeds, the stage SHALL proceed without a durable entitlement block

#### Scenario: Ordinary transient throttle does not trigger model rewrite

- **WHEN** a Claude reviewer invoke is auto-sourced and fails as ordinary rate-limit throttle without the entitlement-specific usage-credit signal
- **THEN** the pipeline SHALL NOT rewrite the model to `sonnet` as an entitlement fallback
- **AND** the failure SHALL be classified as transient rate-limit for durable recovery

#### Scenario: Non-claude reviewer is out of scope for this fallback

- **WHEN** the effective reviewer harness is `codex` (or another non-claude registered reviewer) and the model source was `auto`
- **THEN** the pipeline SHALL NOT apply the Claude entitlement → `sonnet` model rewrite
- **AND** existing auto alias omission for Claude-only models on non-claude reviewers SHALL continue to apply

### Requirement: Explicit non-auto reviewer models SHALL fail closed on entitlement

When the reviewer model did **not** originate from `"auto"` (explicit `models.review`, explicit structured `review_harness.model`, or an explicit CLI model override), the pipeline SHALL NOT replace that model with `sonnet` or any other model on entitlement failure. The failure SHALL remain visible to the operator and SHALL carry a typed durable blocker when it blocks the stage.

#### Scenario: Explicit fable model is never silently rewritten

- **WHEN** `models.review` is the explicit string `"claude-fable-5"` (not `"auto"`) and Claude returns the usage-credit entitlement 429
- **THEN** the pipeline SHALL NOT retry with `sonnet` as a silent rewrite
- **AND** the stage SHALL block with a typed entitlement/capability failure rather than `workflow-engine-defect`

### Requirement: Requested and resolved models SHALL be recorded on entitlement paths

For every reviewer harness attempt in the entitlement path (preferred auto attempt and allowlisted retry), stage accounting SHALL record the requested model, the resolved or served model when known, and whether a fallback occurred (`fallback: true` on the successful or attempted allowlisted retry). Accounting SHALL remain observational for stage routing except for this recorded provenance.

#### Scenario: Successful auto entitlement fallback is accounted

- **WHEN** an auto-sourced `claude-fable-5` attempt fails entitlement and the `sonnet` retry succeeds
- **THEN** accounting for the attempts SHALL include requested model `claude-fable-5` on the first attempt and requested model `sonnet` on the retry
- **AND** at least one record on the path SHALL mark `fallback` as true
- **AND** resolved/served model fields SHALL be populated when the harness reports them

### Requirement: Entitlement and ordinary throttle SHALL NOT collapse to workflow-engine-defect

A zero-token, short-duration harness failure that is either (a) ordinary transient throttling or (b) the Fable/usage-credit entitlement class SHALL project to a typed durable blocker class: ordinary throttle to `transient-rate-limit`, and exhausted/explicit entitlement refusal to `environment-auth` (via a distinct canonical reason such as `model-entitlement-required` or `capability-refusal`). Neither case SHALL be classified as `workflow-engine-defect` solely because token counts are zero, duration is short, or the harness stdout is not a parseable verdict.

#### Scenario: Entitlement after exhausted auto fallback is typed environment-auth

- **WHEN** auto entitlement fallback is attempted and the allowlisted `sonnet` retry also fails with entitlement/capability refusal, or an explicit fable model fails entitlement
- **THEN** durable classification SHALL be `environment-auth` (or the project’s equivalent capability class for that reason code)
- **AND** it SHALL NOT be `workflow-engine-defect`

#### Scenario: Ordinary throttle remains transient-rate-limit

- **WHEN** a reviewer harness failure is ordinary rate-limit throttle without entitlement text
- **THEN** durable classification SHALL be `transient-rate-limit`
- **AND** it SHALL NOT be `workflow-engine-defect`

#### Scenario: Unparseable entitlement text is not an approve

- **WHEN** design-gate or plan-review receives the raw usage-credit message instead of a verdict JSON object
- **THEN** the pipeline SHALL NOT treat that text as an approval
- **AND** when the failure is recognized as entitlement (or throttle), classification SHALL follow the typed rules above rather than a generic engine-defect path driven only by parse failure

### Requirement: Plan-review recovery SHALL preserve a completed plan

When planning has already completed successfully for the item and plan-review fails with transient throttle or entitlement (including after auto fallback exhaustion), durable recovery SHALL redispatch **plan-review** (or wait-and-retry on that stage) and SHALL NOT re-run the planning stage from scratch solely because the reviewer could not start.

#### Scenario: Three identical plan-review entitlement failures do not replan twice

- **WHEN** planning has produced a completed plan artifact and plan-review fails three times with the same entitlement signal under recovery budget
- **THEN** recovery attempts SHALL target plan-review without re-invoking planning harness work for a new plan
- **AND** the completed plan artifact SHALL remain the plan under review

### Requirement: Design-gate recovery SHALL preserve a valid decision record

When the design-gate stage has already recorded a validated decision record version for the issue and a later reviewer interrogation or re-ask fails with transient throttle or entitlement, durable recovery SHALL reuse that decision record and SHALL NOT re-generate a new decision record solely because the reviewer could not start.

#### Scenario: Decision record reused across reviewer entitlement recovery

- **WHEN** design-gate state already contains at least one validated decision record version and the interrogation reviewer fails entitlement
- **THEN** recovery of the reviewer round SHALL reuse the existing decision record
- **AND** the implementer harness SHALL NOT be re-invoked only to rebuild that record

### Requirement: Both invocation-relative profiles keep reviewer ownership

Codex-primary (Claude reviewer) SHALL use the Claude entitlement fallback path for auto-sourced reviewer models. Claude-primary (Codex reviewer) SHALL keep Codex as the reviewer and SHALL NOT gain a forced Claude-only alias from this change. Profile-relative implementer/reviewer ownership SHALL remain as configured by profiles and repository harness roles.

#### Scenario: Codex-primary auto review recovers on subscription Claude

- **WHEN** the active profile is codex-primary with Claude as reviewer and `models.review` is `"auto"`
- **THEN** adversarial review SHALL attempt the preferred auto Claude model and MAY fall back once to `sonnet` on entitlement
- **AND** the implementer role SHALL remain the Codex implementer for implementer stages

#### Scenario: Claude-primary Codex reviewer is unchanged

- **WHEN** the active profile is claude-primary with Codex as reviewer and `models.review` is `"auto"`
- **THEN** the reviewer harness SHALL remain `codex`
- **AND** the pipeline SHALL NOT pass `claude-fable-5` to the Codex reviewer as an auto-resolved model flag

