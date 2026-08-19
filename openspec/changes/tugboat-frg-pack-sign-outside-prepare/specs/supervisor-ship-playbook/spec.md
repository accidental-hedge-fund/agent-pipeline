## ADDED Requirements

### Requirement: Ship playbook FRG pack SHALL unset attestor env and sign outside prepare

The documented alternate chain playbook SHALL compose the same Factory Reliability Gate (FRG) pack isolation as Tugboat. The playbook SHALL invoke `pipeline factory-release prepare` with `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in the prepare child. When prepare returns `status: "awaiting_frg_attestation"` or unsigned eligible artifacts exist for the bound request, the playbook SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate child that has the producer credential. Pack-done SHALL require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate SHA (and version; and `action_id` when recorded), or prepare `status: "complete"` with an open release PR for that version. Prepare status `awaiting_frg_attestation` alone SHALL NOT be pack-done. The playbook SHALL NOT persist the FRG key body in `state.json`. The playbook SHALL NOT keep a second pack protocol that treats unsigned wait as done.

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

#### Scenario: Playbook helpers stay in sync with Tugboat

- **WHEN** an automated check compares Tugboat and `frg-pack-helpers.sh` pack helpers
- **THEN** request writing, pack-tick classification, and attestor compose SHALL match
- **AND** the check SHALL fail if the playbook copy still treats `awaiting_frg_attestation` as done
