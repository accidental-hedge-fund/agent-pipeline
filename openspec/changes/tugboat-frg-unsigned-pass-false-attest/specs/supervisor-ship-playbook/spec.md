## MODIFIED Requirements

### Requirement: Ship playbook FRG pack SHALL unset attestor env and sign outside prepare

The documented alternate chain playbook SHALL compose the same Factory Reliability Gate (FRG) pack isolation as Tugboat. The playbook SHALL invoke `pipeline factory-release prepare` with `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in the prepare child. When prepare returns `status: "awaiting_frg_attestation"` or unsigned eligible artifacts exist for the bound request, the playbook SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate child that has the producer credential. Pack-done SHALL require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate SHA (and version; and `action_id` when recorded), or prepare `status: "complete"` with an open release PR for that version. Prepare status `awaiting_frg_attestation` alone SHALL NOT be pack-done. Unsigned eligible omitted-HMAC `latest.json` `pass: false` SHALL be `attest`, not pack-fail. A prior candidate's signed `latest.json` `pass: false` SHALL NOT fail a current in-progress unsigned-eligible tick. The playbook SHALL NOT persist the FRG key body in `state.json`. The playbook SHALL NOT keep a second pack protocol that treats unsigned wait as done.

Shared pack helpers used by Tugboat and the playbook SHALL stay in sync for request writing, pack-tick classification, and attestor compose.

#### Scenario: Playbook prepare child unsets KEY_FILE

- **WHEN** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **AND** the ship playbook invokes `pipeline factory-release prepare`
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Playbook awaiting is not pack-done

- **WHEN** the ship playbook classify helper sees prepare status `awaiting_frg_attestation`
- **AND** `latest.json` is missing or is not bound `pass: true`
- **THEN** the helper SHALL NOT report pack-done

#### Scenario: Playbook attestor child is outside prepare

- **WHEN** prepare returns `status: "awaiting_frg_attestation"` for version `1.39.0` with bound `loop_run_id` `L`
- **THEN** the playbook SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential

#### Scenario: Playbook in-progress unsigned eligible artifacts are attested

- **WHEN** prepare returns `status: "in_progress"` for version `1.39.0`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** the bound pack `loop_run_id` is `L`
- **AND** no matching `latest.json` `pass: true` exists
- **THEN** the playbook SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential
- **AND** the classify helper SHALL NOT report wait-only retry for that tick

#### Scenario: Playbook stale signed failing latest.json does not fail a newer unsigned-eligible tick

- **WHEN** `.agent-pipeline/frg/1.39.5/latest.json` has `pass: false` with HMAC present bound to a prior candidate SHA
- **AND** prepare returns `status: "in_progress"` for a new request for version `1.39.5`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** no matching `latest.json` `pass: true` exists for the new candidate
- **THEN** the helper SHALL report `attest`
- **AND** it SHALL NOT report pack-fail

#### Scenario: Playbook unsigned eligible omitted-HMAC pass false is attest

- **WHEN** the ship playbook classify helper sees prepare status `awaiting_frg_attestation`
- **AND** `latest.json` has `pass: false` because HMAC was omitted
- **AND** the bound pack is structurally eligible
- **THEN** the helper SHALL report `attest`
- **AND** it SHALL NOT report pack-fail

#### Scenario: Playbook helpers stay in sync with Tugboat

- **WHEN** an automated check compares Tugboat and `frg-pack-helpers.sh` pack helpers
- **THEN** request writing, pack-tick classification, and attestor compose SHALL match
- **AND** the check SHALL fail if the playbook copy still treats `awaiting_frg_attestation` as done
- **AND** the check SHALL fail if either copy still treats unsigned eligible omitted-HMAC `pass: false` as `fail`
- **AND** the check SHALL fail if either copy classifies in-progress unsigned eligible artifacts as `fail` because a prior candidate's signed `pass: false` remains in `latest.json`
