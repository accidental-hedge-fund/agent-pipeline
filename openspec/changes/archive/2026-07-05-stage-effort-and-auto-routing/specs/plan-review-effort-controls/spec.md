## REMOVED Requirements

### Requirement: Plan-review codex invocation SHALL cap reasoning effort to medium

**Reason:** Superseded. Issue #366 makes plan-review reasoning effort operator-configurable via `cfg.effort.planning`, replacing the hardcoded, non-overridable `medium` cap. The default remains `medium` when the operator sets nothing, so default behavior is unchanged; the only new freedom is to raise (or lower) it. See the replacement requirement below.

## ADDED Requirements

### Requirement: Plan-review reasoning effort SHALL be sourced from resolved cfg.effort.planning

The plan-review invocation in `planning.ts` SHALL pass its reasoning effort from the resolved `cfg.effort.planning` value rather than a hardcoded literal. When `effort.planning` is unset, the resolved plan-review effort SHALL default to `"medium"`, preserving prior behavior. When `effort.planning` is `"auto"`, it SHALL resolve using the plan-review classification (Adversarial/Definitive → `"max"`). The literal string `"auto"` SHALL NOT be passed to the harness.

#### Scenario: plan-review effort defaults to medium when unset

- **WHEN** `.github/pipeline.yml` has no `effort:` block
- **THEN** the plan-review invocation SHALL pass `reasoningEffort: "medium"`

#### Scenario: plan-review effort overridden by config

- **WHEN** `.github/pipeline.yml` sets `effort: { planning: max }`
- **THEN** the plan-review invocation SHALL pass `reasoningEffort: "max"`

#### Scenario: plan-review effort auto resolves to max

- **WHEN** `.github/pipeline.yml` sets `effort: { planning: auto }`
- **THEN** the plan-review invocation SHALL pass `reasoningEffort: "max"` (Adversarial/Definitive)
- **AND** the harness SHALL NOT receive the literal `"auto"`

#### Scenario: review-1 and review-2 unaffected by plan-review effort

- **WHEN** the pipeline reaches review-1 or review-2
- **THEN** their reasoning effort SHALL be sourced from `cfg.harnesses.reviewerEffort ?? cfg.effort.review`, independent of `cfg.effort.planning`
