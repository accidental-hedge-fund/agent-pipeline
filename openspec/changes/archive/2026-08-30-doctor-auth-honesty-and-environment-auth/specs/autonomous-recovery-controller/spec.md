## ADDED Requirements

### Requirement: Provider credential failure SHALL project to environment-auth, not workflow-engine-defect

The engine SHALL classify provider credential failures as `pipeline/stage-diagnostic@1` reason `environment-auth` when production preflight sets `preflight_reason_code` to `environment-auth`, when structured provider status after spawn reports an invalidated or unauthenticated session, or when an exact allowlisted compatibility marker such as `refresh_token_invalidated` is present. Those diagnostics SHALL project to durable class `environment-auth` with disposition recover. Recovery SHALL use the existing `verify_authentication` recipe. The durable stop theme SHALL be the existing string `environment-auth`. The engine SHALL NOT add a new `DurableBlockerClass` or stop-theme member for this class. The engine SHALL NOT project these failures to `harness-contract` or `workflow-engine-defect`. Arbitrary stderr prose SHALL NOT be sufficient for this class.

#### Scenario: Unauthenticated preflight does not become harness-contract

- **WHEN** a harness result carries `preflight_reason_code` `environment-auth`
- **THEN** the diagnostic reason SHALL be `environment-auth`
- **AND** the durable class and stop theme SHALL be `environment-auth`
- **AND** SHALL NOT be `harness-contract` or `workflow-engine-defect`

#### Scenario: Revoked refresh token after spawn is environment-auth

- **WHEN** a spawned harness returns structured provider status or an allowlisted `refresh_token_invalidated` marker
- **THEN** the diagnostic reason SHALL be `environment-auth`
- **AND** recovery policy for that class SHALL list `verify_authentication`
- **AND** a run-fatal stop recorded for that item SHALL use theme `environment-auth`

#### Scenario: Unallowlisted prose is not environment-auth

- **WHEN** a harness result has a non-zero exit and stderr that only contains unallowlisted prose such as `please log in`
- **AND** `preflight_reason_code` is absent and no structured provider status or allowlisted marker is present
- **THEN** classification SHALL NOT emit `environment-auth` from that prose
- **AND** SHALL keep the existing mechanical mapping (`harness-contract` or equivalent)

#### Scenario: No new theme string is introduced

- **WHEN** the closed `DurableBlockerClass` set is inspected after this change
- **THEN** it SHALL still contain `environment-auth` as the credential-failure theme
- **AND** SHALL NOT contain a newly minted auth-specific theme token
