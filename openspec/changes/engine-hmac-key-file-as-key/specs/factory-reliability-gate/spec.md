## ADDED Requirements

### Requirement: Engine HMAC-verify SHALL present KEY_FILE as KEY

Engine HMAC-verify entries SHALL present the producer credential using one recipe before HMAC mint or verify. Those entries are `pipeline factory-gate --from-run` and `pipeline release ensure-tag`. The recipe SHALL be:

1. If `PIPELINE_FRG_ATTESTATION_KEY` is already set, inherit it and unset `PIPELINE_FRG_ATTESTATION_KEY_FILE` for that HMAC operation.
2. Else if `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty, fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT mint or verify HMAC.
3. Else if that file is unreadable, fail closed with named reason `unreadable_attestor_key_file` (or equivalent) and SHALL NOT mint or verify HMAC.
4. Else if that file is empty (zero bytes), fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT mint or verify HMAC.
5. Else set `PIPELINE_FRG_ATTESTATION_KEY` from the file body and unset `PIPELINE_FRG_ATTESTATION_KEY_FILE` for that HMAC operation.

HMAC mint and verify SHALL still authenticate with `PIPELINE_FRG_ATTESTATION_KEY` after presentation. The engine SHALL NOT leave HMAC mint or verify without a credential when `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty file. The engine SHALL NOT require a Tugboat-only env wrap or a human `env PIPELINE_FRG_ATTESTATION_KEY=…` as the product path. GitHub Actions auto-tag SHALL still use repo secret `PIPELINE_FRG_ATTESTATION_KEY`. Unsigned `factory-release prepare` SHALL still have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in that child. The engine SHALL NOT persist the key body in ship state.

This requirement does not authorize `--skip-frg` as the ship path. It does not authorize tagging from unsigned `pass: true`. It does not place the key body in SKILL.md.

#### Scenario: factory-gate --from-run presents KEY_FILE as KEY

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `pipeline factory-gate --from-run` would mint or verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** it SHALL NOT require a Tugboat env wrap

#### Scenario: release ensure-tag presents KEY_FILE as KEY

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `pipeline release ensure-tag` would verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** it SHALL NOT require a Tugboat env wrap

#### Scenario: HMAC inherits KEY and unsets KEY_FILE

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY` set to `inline-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is also set
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `inline-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: HMAC-verify fails closed without a credential

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: HMAC-verify fails closed on unreadable KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names an unreadable file
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `unreadable_attestor_key_file` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: HMAC-verify fails closed on empty KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names a readable empty file
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: Prepare stays uncredentialed when parent has KEY_FILE

- **WHEN** a ship-path composer invokes `pipeline factory-release prepare`
- **AND** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Next identical KEY_FILE-only HMAC-verify needs no new mole

- **WHEN** a later Claude Code or Hermes host has only `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file
- **AND** that host runs `factory-gate --from-run` or `release ensure-tag`
- **THEN** the same presentation recipe SHALL supply `PIPELINE_FRG_ATTESTATION_KEY` from that file
- **AND** HMAC mint or verify SHALL NOT require a Tugboat wrap, a human `env PIPELINE_FRG_ATTESTATION_KEY=…`, or a new mole issue
