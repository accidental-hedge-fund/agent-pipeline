## MODIFIED Requirements

### Requirement: The gate SHALL use the configured independent reviewer and disclose fallback

When the gate fires, the interrogation round SHALL be invoked through `cfg.harnesses.reviewer` with a concrete model and effort resolved through the **same reviewer model chain** used by plan-review and standard review rounds: structured `cfg.harnesses.reviewerModel` / `reviewerEffort` when set (from `review_harness` object form), otherwise `cfg.models.review` / the resolved review effort key, after `"auto"` expansion and `resolveReviewerModelForHarness` (or equivalent shared guard). The run SHALL record a `reviewerIdentity` (harness, model, effort) and a `reviewerIndependence` value of `independent` when the reviewer harness differs from the implementer harness, or `same-harness-fallback` when it does not. Under `same-harness-fallback` the round SHALL still execute, and the disclosure SHALL appear in both the posted gate comment and the evidence bundle.

When structured `reviewerModel` is unset and `models.review` is `"auto"` (or resolves through auto), `reviewerIdentity.model` SHALL be the concrete auto-resolved model (for a Claude reviewer, the preferred adversarial model such as `claude-fable-5`), never `undefined`/null solely because structured `review_harness` was omitted. Both the initial interrogation and the bounded re-ask SHALL pass that concrete model (and effort) to the harness. The design-gate path SHALL participate in auto entitlement fallback and typed classification as specified by `review-auto-entitlement-fallback`. When prior gate state reloads a `reviewerIdentity` with a missing model under auto-sourced configuration, the gate SHALL re-resolve the model from current config rather than reusing an empty identity that would omit `--model`.

#### Scenario: independent reviewer
- **WHEN** the implementer harness is `claude` and `cfg.harnesses.reviewer` is `codex`
- **THEN** the interrogation SHALL be invoked with `codex`
- **AND** `reviewerIndependence` SHALL be `independent`

#### Scenario: same-harness fallback is executed and disclosed
- **WHEN** `cfg.harnesses.reviewer` resolves to the same harness and model as the implementer
- **THEN** the interrogation round SHALL still run
- **AND** `reviewerIndependence` SHALL be `same-harness-fallback`
- **AND** the posted gate comment SHALL contain an explicit same-harness fallback disclosure

#### Scenario: reviewer harness unavailable — gate blocks
- **WHEN** the reviewer harness CLI cannot be invoked
- **THEN** the gate SHALL NOT advance to `review-1`
- **AND** the issue SHALL be blocked with a harness-failure blocker naming the unavailable reviewer

#### Scenario: unstructured models.review auto supplies a concrete Claude model
- **WHEN** the gate fires with no structured `review_harness`, `models.review` is `"auto"`, and `cfg.harnesses.reviewer` is `claude`
- **THEN** `reviewerIdentity.model` SHALL be the concrete auto-resolved adversarial model (not undefined)
- **AND** both the initial interrogation invoke and the bounded re-ask SHALL pass that model to the Claude harness
- **AND** the Claude process arguments SHALL include an explicit `--model` flag for that value on first attempt

#### Scenario: design-gate auto entitlement follows shared fallback rules
- **WHEN** design-gate’s auto-sourced Claude reviewer receives a Fable usage-credit entitlement 429 with zero tokens
- **THEN** the gate SHALL apply the shared auto entitlement allowlisted retry to `sonnet` (or fail closed with a typed entitlement blocker if retry is exhausted/ineligible)
- **AND** it SHALL NOT treat the entitlement text as a valid interrogation verdict

#### Scenario: prior null model identity is re-resolved under auto
- **WHEN** a prior design-gate comment decodes `reviewerIdentity.model` as null/empty and current config is auto-sourced for the reviewer model
- **THEN** the gate SHALL re-resolve a concrete model from current config before invoking the reviewer
- **AND** it SHALL NOT omit `--model` solely because the prior identity lacked a model field

## ADDED Requirements

### Requirement: Design-gate SHALL preserve a valid decision record across reviewer-only recovery

When at least one validated decision record version is already stored for the issue in design-gate state, a reviewer interrogation or re-ask failure caused by transient throttle or model entitlement SHALL NOT force regeneration of the decision record. Recovery and retries SHALL reuse the existing decision record for subsequent interrogation rounds.

#### Scenario: reviewer failure after decision record does not re-run implementer extraction
- **WHEN** `decisionRecordVersions` already contains a validated record and the interrogation reviewer fails with entitlement or throttle
- **THEN** the next recovery attempt SHALL reuse that decision record as the interrogation input
- **AND** the implementer harness SHALL NOT be invoked solely to produce a replacement decision record for that failure class
