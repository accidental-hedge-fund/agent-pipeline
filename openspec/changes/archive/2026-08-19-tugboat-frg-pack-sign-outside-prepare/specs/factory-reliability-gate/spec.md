## ADDED Requirements

### Requirement: Ship-path FRG pack composers SHALL attest outside prepare

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` copy, or any later composer of the same durable prepare protocol) SHALL keep production attestation out of the `factory-release prepare` process. The composer SHALL invoke prepare with `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in that child. After prepare returns `status: "awaiting_frg_attestation"` or unsigned eligible artifacts exist for the bound request, the composer SHALL run `pipeline factory-gate --for <target-version> --from-run <loop_run_id>` (no `--observations`) in a separate process that has the producer credential. Pack-done for that composer SHALL require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate. Prepare status `awaiting_frg_attestation` alone SHALL NOT be release-eligible pack-done. The composer SHALL NOT persist the key body in ship state. The next supervisor that sources `PIPELINE_FRG_ATTESTATION_KEY_FILE` into the parent environment SHALL NOT require a new mole issue or a human unset to finish pack.

This requirement does not change prepare's refuse of attestor env. It does not authorize `--skip-frg` as the ship path. It does not place the key in the candidate-loop environment.

#### Scenario: Prepare process remains uncredentialed

- **WHEN** a ship-path composer invokes `pipeline factory-release prepare` and the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **THEN** the prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** prepare SHALL still refuse to run if those variables are present in its environment

#### Scenario: Unsigned wait is not release-eligible pack-done

- **WHEN** prepare returns `status: "awaiting_frg_attestation"`
- **AND** no bound `latest.json` `pass: true` exists for the request candidate
- **THEN** a ship-path composer SHALL NOT declare pack-done
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Attestor runs in a separate credentialed process

- **WHEN** unsigned eligible artifacts exist for bound loop `L` and version `X.Y.Z`
- **THEN** the composer SHALL invoke `pipeline factory-gate --for X.Y.Z --from-run L` in a process other than prepare
- **AND** that process SHALL have the producer credential
- **AND** that process SHALL NOT pass `--observations`

#### Scenario: In-progress unsigned eligible artifacts still get an attestor child

- **WHEN** prepare returns `status: "in_progress"` with unsigned eligible artifacts for bound loop `L` and version `X.Y.Z`
- **AND** no bound `latest.json` `pass: true` exists
- **THEN** the composer SHALL invoke `pipeline factory-gate --for X.Y.Z --from-run L` in a process other than prepare
- **AND** that process SHALL have the producer credential
- **AND** that process SHALL NOT pass `--observations`
- **AND** the composer SHALL NOT wait that tick as status-only retry

#### Scenario: Next identical supervisor env fault needs no new mole

- **WHEN** a later ship parent environment again sources `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** train is complete and the operator escape is not active
- **THEN** the same composer isolation SHALL unset those variables for prepare and sign in the attestor child
- **AND** FRG pack SHALL be able to reach bound `latest.json` `pass: true` without a human unsetting env
