## ADDED Requirements

### Requirement: Tugboat HMAC-verify children SHALL present KEY_FILE as KEY

Tugboat children that verify Factory Reliability Gate HMAC SHALL present the producer credential using one recipe. Those children are the FRG pack attestor (`pipeline factory-gate --from-run`) and candidate `release ensure-tag`. The recipe SHALL be:

1. If `PIPELINE_FRG_ATTESTATION_KEY` is already set, inherit it and spawn with `env -u PIPELINE_FRG_ATTESTATION_KEY_FILE`.
2. Else if `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty, fail closed with named stderr reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
3. Else if that file is unreadable, fail closed with named stderr reason `unreadable_attestor_key_file` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
4. Else if that file is empty (`! -s`), fail closed with named stderr reason `missing_attestor_credential` (or equivalent) and SHALL NOT spawn the HMAC-verify CLI.
5. Else spawn the HMAC-verify CLI with `PIPELINE_FRG_ATTESTATION_KEY` set to the file body (`cat --` of `PIPELINE_FRG_ATTESTATION_KEY_FILE`) and `env -u PIPELINE_FRG_ATTESTATION_KEY_FILE`.

Tugboat SHALL NOT leave HMAC verify without a credential when `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty file. Tugboat SHALL NOT persist the key body in `state.json`. Tugboat SHALL NOT require a human `env PIPELINE_FRG_ATTESTATION_KEY=…` wrap as the ship path.

#### Scenario: Ensure-tag presents KEY_FILE as KEY

- **WHEN** the supervisor environment sets `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** Tugboat invokes candidate `release ensure-tag` after `release finish`
- **THEN** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Ensure-tag inherits KEY and unsets KEY_FILE

- **WHEN** the supervisor environment sets `PIPELINE_FRG_ATTESTATION_KEY` to `inline-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is also set
- **AND** Tugboat invokes candidate `release ensure-tag`
- **THEN** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to `inline-key`
- **AND** that ensure-tag child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Ensure-tag fails closed without a credential

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Ensure-tag fails closed on unreadable KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names an unreadable file
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `unreadable_attestor_key_file` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Ensure-tag fails closed on empty KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names a readable empty file
- **AND** Tugboat would invoke candidate `release ensure-tag`
- **THEN** Tugboat SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT spawn `release ensure-tag`

#### Scenario: Attestor and ensure-tag share the same KEY_FILE recipe

- **WHEN** the supervisor environment sets only `PIPELINE_FRG_ATTESTATION_KEY_FILE` to a readable non-empty file
- **AND** Tugboat invokes the FRG pack attestor child and later invokes candidate `release ensure-tag`
- **THEN** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY` equal to that file body
- **AND** both children SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** Tugboat SHALL NOT require a human to export `PIPELINE_FRG_ATTESTATION_KEY` between those phases

### Requirement: Tugboat ensure-tag KEY_FILE mapping SHALL be regression-tested

Automated checks SHALL extract the real Tugboat ensure-tag HMAC-verify helper and the sibling FRG pack attestor helper from `examples/supervisor/shell/tugboat.sh`. With `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty dummy file, a fake ship-end CLI env recorder SHALL record ensure-tag child env `KEY=<dummy body>` and `KEY_FILE_UNSET`. Those checks SHALL fail if the ensure-tag child has neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE` in that fixture. Tests SHALL inject I/O or inspect extracted helpers. They SHALL NOT start a live tag push, network call, git, or subprocess ship.

#### Scenario: Regression fails if ensure-tag child has neither KEY nor KEY_FILE

- **WHEN** the automated ensure-tag credential checks run against a Tugboat helper that spawns `release ensure-tag` with `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** the parent supplied a readable non-empty `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** the child env records neither `PIPELINE_FRG_ATTESTATION_KEY` nor `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **THEN** the checks SHALL fail

#### Scenario: Regression records KEY from KEY_FILE and unsets KEY_FILE

- **WHEN** the automated ensure-tag credential checks run with `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty dummy file
- **THEN** the fake ship-end CLI env recorder SHALL contain `KEY=<dummy body>`
- **AND** it SHALL contain `KEY_FILE_UNSET`
}
