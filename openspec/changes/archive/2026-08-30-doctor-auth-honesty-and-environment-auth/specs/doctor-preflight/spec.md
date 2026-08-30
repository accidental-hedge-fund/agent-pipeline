## ADDED Requirements

### Requirement: Assigned-harness pass copy SHALL report credentials or login-status present, not verified authentication

Assigned-harness doctor checks SHALL keep using the adapter’s static preflight or runtimeSmoke result as the model-free signal. When that result is ok, the human-readable pass detail, the check description, and the JSON `reason` SHALL state that credentials or login-status are present. They SHALL NOT use the words authenticated, authentication verified, or equivalent claims that a live session probe succeeded. Default `pipeline doctor` without `--harness-smoke` SHALL remain model-free. A fail that the adapter reports as `unauthenticated` SHALL stay distinguishable from missing-CLI and unsupported-setting. Fail remediation MAY instruct the operator to authenticate.

#### Scenario: Passing harness check does not claim live authentication

- **WHEN** an assigned adapter’s static preflight returns ok and `pipeline doctor` runs without `--harness-smoke`
- **THEN** that check SHALL pass
- **AND** the human summary and JSON `reason` SHALL mention credentials or login-status present
- **AND** the pass detail, check description, and JSON `reason` SHALL NOT contain `authenticated` or `verified authentication`

#### Scenario: Default doctor still makes no model call

- **WHEN** `pipeline doctor` is invoked without `--harness-smoke`
- **THEN** it SHALL NOT invoke a language model or consume inference tokens

#### Scenario: Unauthenticated fail remains distinct

- **WHEN** an assigned adapter’s static preflight returns not-ok with failure class `unauthenticated`
- **THEN** the harness check SHALL fail
- **AND** the outcome SHALL be distinguishable from missing-CLI and from unsupported-setting
- **AND** remediation MAY instruct the operator to authenticate that CLI

#### Scenario: Pass-copy honesty is unit-testable without a live probe

- **WHEN** unit tests drive assigned-harness checks through the doctor injectable deps seam with a fake preflight ok result
- **THEN** they SHALL assert the pass wording contract above
- **AND** SHALL perform no real subprocess, filesystem, or network call to a provider
