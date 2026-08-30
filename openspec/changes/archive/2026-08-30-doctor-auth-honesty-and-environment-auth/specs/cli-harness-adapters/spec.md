## ADDED Requirements

### Requirement: Provider authentication SHALL be a typed harness signal

Adapters and the shared invoke path SHALL surface provider authentication as a typed signal. Production preflight that reports unauthenticated SHALL set `preflight_reason_code` to `environment-auth`. After spawn, the harness result SHALL prefer a structured provider status object when the CLI emits one. A compatibility fallback MAY match only exact allowlisted codes (including `refresh_token_invalidated` as a JSON `error.code` or equivalent closed field, and a structured HTTP 401 on that status object). The path SHALL NOT classify arbitrary stderr or transcript prose as unauthenticated. Missing structured status without an allowlisted marker SHALL NOT be invented as authenticated or as environment-auth.

#### Scenario: Unauthenticated preflight is typed environment-auth

- **WHEN** production preflight refuses spawn because the adapter reports `unauthenticated`
- **THEN** the harness result SHALL set `preflight_reason_code` to `environment-auth`
- **AND** SHALL NOT require matching free-form stderr text as the primary signal

#### Scenario: Structured provider status after spawn is preferred

- **WHEN** a spawned CLI emits a structured provider status whose closed field reports an invalidated or unauthenticated session
- **THEN** the harness result SHALL carry that structured status for classification
- **AND** classification consumers SHALL prefer that status over leftover log prose

#### Scenario: Allowlisted compatibility marker is exact

- **WHEN** CLI output contains a JSON object whose closed `error.code` (or equivalent) equals `refresh_token_invalidated`
- **THEN** that marker SHALL be accepted as a compatibility auth signal
- **AND** an English sentence such as `please log in` without an allowlisted closed field SHALL NOT be accepted as that signal

#### Scenario: Served-model telemetry stays unchanged

- **WHEN** a Codex (or other) adapter has no recorded current CLI fixture that proves a served-model field
- **THEN** `resolved_model` SHALL remain absent or null
- **AND** this requirement SHALL NOT invent a served-model parse
