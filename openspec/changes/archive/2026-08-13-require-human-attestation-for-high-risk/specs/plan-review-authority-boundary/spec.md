## ADDED Requirements

### Requirement: Operator surfaces SHALL distinguish pre-code human attestation from plan-review

Operator-facing documentation, host skill guidance, and high-traffic authority copy that describe plan-review and high-risk controls SHALL keep these terms distinct:

1. **Independent agent plan review** remains evidence from the configured secondary reviewer (or labeled same-harness self-review fallback) — not human approval.
2. **Human feedback window** remains optional steering — not approval.
3. **Pre-code human attestation** is the opt-in, risk-triggered human authority gate defined by `pre_code_attestation` — required only when configured and triggered.
4. **Human attestation** as pipeline output provenance markers remains distinct from pre-code human approval of a design dossier.

Surfaces SHALL NOT claim that plan-review is the human sign-off before implementation, and SHALL NOT
claim that pre-code human attestation runs for every change when the config is omitted or untriggered.

#### Scenario: plan-review is not redefined as human sign-off

- **WHEN** operator-facing documentation describes `plan-review` after this change
- **THEN** it SHALL still describe independent agent plan review plus an optional human feedback window
- **AND** SHALL NOT state that plan-review is human sign-off for high-risk work

#### Scenario: pre-code attestation described as opt-in and risk-triggered

- **WHEN** documentation describes `pre_code_attestation`
- **THEN** it SHALL state that the control is opt-in via configuration and fires only when risk triggers match
- **AND** SHALL state that omitted configuration preserves autonomous advancement without this human gate

#### Scenario: authority drift-guard still forbids plan-review equals sign-off

- **WHEN** high-traffic copy equates plan-review with human sign-off without distinction
- **THEN** the existing plan-review authority drift-guard SHALL still fail
)
