## ADDED Requirements

### Requirement: Doctor SHALL admit and report the configured git push-auth mechanism

`pipeline doctor` SHALL include a preflight check that admits the resolved git push-auth configuration. The check SHALL report the resolved mechanism (`ssh` or `https-token`) and, for `https-token`, the configured environment-variable **name** without printing the secret value. When the mechanism is `https-token` and the named environment variable is unset or empty, the check SHALL **fail** with an operator-actionable message that names the missing variable. When the mechanism is `ssh`, the check SHALL **pass** for configuration admission of the default SSH mechanism (without requiring a PAT `workflow` scope). The check SHALL be unit-testable via the doctor injectable deps seam without performing a real network git push.

#### Scenario: doctor reports SSH mechanism

- **WHEN** the resolved push-auth mechanism is `ssh` and the operator runs `pipeline doctor`
- **THEN** the doctor results SHALL include a check that reports mechanism `ssh`
- **AND** that check SHALL pass for configuration admission of SSH

#### Scenario: doctor fails when HTTPS-token env var is missing

- **WHEN** the resolved push-auth mechanism is `https-token` with token environment name `GITHUB_PUSH_TOKEN` and that variable is unset or empty
- **AND** the operator runs `pipeline doctor`
- **THEN** the doctor check for push-auth SHALL fail
- **AND** the failure message SHALL name `GITHUB_PUSH_TOKEN`
- **AND** the failure message SHALL NOT include a secret token value

#### Scenario: doctor passes when HTTPS-token env var is present

- **WHEN** the resolved push-auth mechanism is `https-token` with token environment name `GITHUB_PUSH_TOKEN` and that variable is set to a non-empty value
- **AND** the operator runs `pipeline doctor`
- **THEN** the doctor check for push-auth SHALL pass configuration readiness for the named env var’s presence
- **AND** doctor output SHALL NOT print the variable’s secret value

#### Scenario: push-auth doctor check is unit-testable without network push

- **WHEN** unit tests exercise the push-auth doctor check with injectable deps
- **THEN** the tests SHALL assert pass/fail outcomes for `ssh` and for `https-token` with set vs unset env
- **AND** the tests SHALL NOT require a real git push or GitHub network call
