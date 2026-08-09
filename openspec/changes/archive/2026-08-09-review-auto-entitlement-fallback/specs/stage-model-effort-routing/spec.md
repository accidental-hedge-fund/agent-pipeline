## ADDED Requirements

### Requirement: Config-load adversarial auto preference MAY be refined at runtime for Claude entitlement only

Config-load resolution for Adversarial `auto` SHALL continue to prefer the full id `claude-fable-5` for a Claude reviewer (see existing adversarial auto requirements). That preferred value is the **first** model requested at runtime. When the model source is `"auto"` and the Claude reviewer returns a deterministic Fable/usage-credit entitlement failure, the pipeline MAY request the allowlisted subscription-backed model `sonnet` on a single subsequent attempt as specified by `review-auto-entitlement-fallback`. Config-load resolution SHALL NOT rewrite the preferred auto value to `sonnet` solely because the host account may lack Fable credits. Explicit non-`auto` model strings SHALL remain unchanged at both config-load and runtime.

#### Scenario: Config-load still prefers fable under auto

- **WHEN** `models.review` is `"auto"` and the effective reviewer is `claude`
- **THEN** the config-load resolved review model SHALL be `"claude-fable-5"`
- **AND** the first Claude reviewer invoke for an adversarial stage SHALL request that preferred model before any entitlement fallback

#### Scenario: Runtime entitlement fallback does not mutate resolved config preference

- **WHEN** an auto-sourced Claude reviewer falls back once to `sonnet` after a Fable entitlement failure
- **THEN** the config-load resolved `models.review` preference for auto SHALL remain `"claude-fable-5"` for subsequent stages that re-resolve from config
- **AND** only the failed attempt’s in-process retry SHALL use `sonnet`

#### Scenario: Explicit model string is not auto-fallback eligible at routing layer

- **WHEN** `models.review` is the explicit string `"claude-fable-5"`
- **THEN** routing SHALL treat the model as non-auto
- **AND** no entitlement model rewrite SHALL be authorized by the auto routing layer
