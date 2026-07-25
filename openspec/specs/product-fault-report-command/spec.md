# product-fault-report-command Specification

## Purpose
TBD - created by archiving change product-fault-reporting. Update Purpose after archive.
## Requirements
### Requirement: Product-fault reporting SHALL be disabled by default and fully inert

The engine SHALL treat product-fault reporting as opt-in. When the `product_fault` config block is
absent, or when it resolves to disabled, the engine SHALL perform no network reporting, SHALL make
no `gh` write calls on behalf of this feature, SHALL create no GitHub issue, and SHALL produce
output, artifacts, event streams, and exit status identical to the behavior before this feature
existed. The `product_fault` config block SHALL be a strict schema object (unknown keys rejected)
that is absent by default.

#### Scenario: absent config is fully inert

- **WHEN** a run completes with no `product_fault` config block present
- **THEN** no network reporting SHALL occur, no `gh` write SHALL be made, and no GitHub issue SHALL
  be created for this feature
- **AND** the run's events, artifacts, printed output, and exit status SHALL be identical to the
  pre-feature behavior

#### Scenario: disabled config performs no submission

- **WHEN** the `product_fault` block is present but resolves to disabled and `pipeline report` is run
- **THEN** the command SHALL perform no network I/O and no `gh` write
- **AND** SHALL inform the operator that reporting is disabled

#### Scenario: strict schema rejects unknown keys

- **WHEN** the `product_fault` config block contains an unknown key
- **THEN** config resolution SHALL throw a schema error identifying the offending field rather than
  silently ignoring it

### Requirement: `pipeline report` SHALL show the exact sanitized payload before explicit submission and record consent

The engine SHALL provide a `pipeline report` command that, when reporting is enabled, builds the
sanitized product-fault payload, renders it in full for operator inspection, and requires an explicit
operator confirmation before any submission. The rendered preview SHALL be byte-identical to the
payload that would be transmitted. There SHALL be no path that submits without first showing the
exact payload. Upon submission the command SHALL write a local consent/audit record capturing the
payload hash, destination, timestamp, and the operator's explicit confirmation.

#### Scenario: preview matches the submitted payload exactly

- **WHEN** an operator runs `pipeline report` with reporting enabled
- **THEN** the command SHALL render the full sanitized payload
- **AND** the rendered content SHALL be byte-identical to what is submitted on confirmation

#### Scenario: submission requires explicit confirmation

- **WHEN** the payload has been previewed and the operator has not explicitly confirmed submission
- **THEN** the command SHALL NOT transmit the payload

#### Scenario: submission records a local consent/audit entry

- **WHEN** an operator explicitly confirms and the payload is submitted
- **THEN** the command SHALL write a local audit record containing the payload hash, destination,
  timestamp, and the operator's confirmation

### Requirement: A no-service manual fallback SHALL prepare a prefilled draft the operator must submit

When no intake service is configured but reporting is invoked, the engine SHALL prepare a prefilled
GitHub issue draft (a browser URL or CLI draft) populated with only the sanitized payload, and SHALL
require the operator to review and submit it themselves. The client itself SHALL NOT create the
upstream issue.

#### Scenario: manual fallback opens a prefilled draft

- **WHEN** `pipeline report` is invoked with reporting enabled and no intake service configured
- **THEN** the command SHALL prepare a prefilled issue draft containing only the sanitized payload
- **AND** the command SHALL NOT itself create the upstream issue

#### Scenario: manual fallback still requires operator review

- **WHEN** the prefilled draft is prepared
- **THEN** submission SHALL require the operator to review and submit it

### Requirement: Background/automatic reporting SHALL be a later phase gated on precision and a reviewed threat model

The engine SHALL NOT enable any background or automatic product-fault reporting in this change. Any
future automatic/opt-in background reporting SHALL be gated on both measured classifier precision
above a reviewed threshold and a signed-off privacy/security threat model. No requirement in this
change SHALL cause reporting to occur without an explicit per-invocation operator action.

#### Scenario: no automatic reporting in this phase

- **WHEN** reporting is enabled in config
- **THEN** no report SHALL be transmitted without an explicit operator `pipeline report` invocation
  and confirmation

#### Scenario: background reporting stays gated

- **WHEN** background/automatic reporting is proposed
- **THEN** it SHALL remain deferred until measured classifier precision meets the reviewed threshold
  and a privacy/security threat model has been signed off

