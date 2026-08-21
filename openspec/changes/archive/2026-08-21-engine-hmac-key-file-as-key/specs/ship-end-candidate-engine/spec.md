## ADDED Requirements

### Requirement: In-engine pipeline ship HMAC-verify children SHALL present KEY_FILE as KEY

In-engine `pipeline ship` SHALL present the producer credential to HMAC-verify children using the same recipe as engine HMAC-verify (`factory-gate --from-run` and `release ensure-tag`). Those children are the FRG pack attestor spawn and the candidate `release ensure-tag` spawn. The recipe SHALL be:

1. If `PIPELINE_FRG_ATTESTATION_KEY` is already set, inherit it and spawn with `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.
2. Else if `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty, fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn HMAC verify.
3. Else if that file is unreadable, fail closed with named reason `unreadable_attestor_key_file` (or equivalent) and SHALL NOT spawn HMAC verify.
4. Else if that file is empty (zero bytes), fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn HMAC verify.
5. Else spawn the HMAC-verify child with `PIPELINE_FRG_ATTESTATION_KEY` set to the file body after removing trailing LF bytes (Tugboat `KEY="$(cat -- "$KEY_FILE")"` command substitution) and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.

Ensure-tag spawn SHALL NOT use the uncredentialed prepare env (the helper that deletes both `KEY` and `KEY_FILE`). Prepare / unsigned `factory-release prepare` SHALL still have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in that child. In-engine `pipeline ship` SHALL NOT leave HMAC verify without a credential when `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty file. It SHALL NOT require a Tugboat-only env wrap or a human `env PIPELINE_FRG_ATTESTATION_KEY=…` as the ship path. It SHALL NOT persist the key body in ship state.

This requirement does not authorize `--skip-frg` as the ship path. It does not authorize tagging from unsigned `pass: true`.

#### Scenario: In-engine attestor presents KEY_FILE as KEY

- **WHEN** the parent environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** in-engine `pipeline ship` invokes the FRG pack attestor child
- **THEN** that attestor child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** that attestor child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: In-engine ensure-tag presents KEY_FILE as KEY

- **WHEN** the parent environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** in-engine `pipeline ship` invokes candidate `release ensure-tag`
- **THEN** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: In-engine KEY_FILE trailing LF is stripped like Tugboat command substitution

- **WHEN** the parent environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file whose body is `dummy-key` followed by a trailing LF
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** in-engine `pipeline ship` invokes the FRG pack attestor child or candidate `release ensure-tag`
- **THEN** that child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key` with no trailing LF
- **AND** that child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: In-engine HMAC children inherit KEY and unset KEY_FILE

- **WHEN** the parent environment sets `PIPELINE_FRG_ATTESTATION_KEY` to `inline-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is also set
- **AND** in-engine `pipeline ship` invokes the attestor child and later invokes candidate `release ensure-tag`
- **THEN** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `inline-key`
- **AND** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: In-engine HMAC-verify fails closed without a credential

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty
- **AND** in-engine `pipeline ship` would invoke the attestor or ensure-tag child
- **THEN** in-engine `pipeline ship` SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn HMAC verify

#### Scenario: In-engine HMAC-verify fails closed on unreadable KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names an unreadable file
- **AND** in-engine `pipeline ship` would invoke the attestor or ensure-tag child
- **THEN** in-engine `pipeline ship` SHALL fail closed with named reason `unreadable_attestor_key_file` (or equivalent)
- **AND** it SHALL NOT spawn HMAC verify

#### Scenario: In-engine HMAC-verify fails closed on empty KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names a readable empty file
- **AND** in-engine `pipeline ship` would invoke the attestor or ensure-tag child
- **THEN** in-engine `pipeline ship` SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn HMAC verify

#### Scenario: Attestor and ensure-tag share the same KEY_FILE recipe

- **WHEN** the parent environment sets only `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file
- **AND** in-engine `pipeline ship` invokes the FRG pack attestor child and later invokes candidate `release ensure-tag`
- **THEN** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to that file body
- **AND** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** in-engine `pipeline ship` SHALL NOT require a Tugboat wrap or a human to export `PIPELINE_FRG_ATTESTATION_KEY` between those phases

#### Scenario: In-engine prepare stays uncredentialed

- **WHEN** in-engine `pipeline ship` invokes `factory-release prepare`
- **AND** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

### Requirement: In-engine ship HMAC-verify child env SHALL be regression-tested

Automated checks SHALL record in-engine `pipeline ship` attestor and ensure-tag child env. With `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty dummy file, those checks SHALL record both children `KEY=<dummy body>` and `KEY_FILE` unset. Those checks SHALL fail if either child has neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE` in that fixture (the current attestor helper that unsets `KEY_FILE` without loading it, or the ensure-tag spawn that uses uncredentialed prepare env). Tests SHALL inject I/O. They SHALL NOT start a live tag push, network call, git, or subprocess ship.

#### Scenario: Regression fails if a HMAC child has neither KEY nor KEY_FILE

- **WHEN** the automated in-engine ship credential checks run against an attestor or ensure-tag spawn helper
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** the parent supplied a readable non-empty `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** the child env records neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **THEN** the checks SHALL fail

#### Scenario: Regression records KEY from KEY_FILE on both HMAC children

- **WHEN** the automated in-engine ship credential checks run with `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty dummy file
- **THEN** the attestor child env SHALL contain `KEY=<dummy body>` and `KEY_FILE` unset
- **AND** the ensure-tag child env SHALL contain `KEY=<dummy body>` and `KEY_FILE` unset
