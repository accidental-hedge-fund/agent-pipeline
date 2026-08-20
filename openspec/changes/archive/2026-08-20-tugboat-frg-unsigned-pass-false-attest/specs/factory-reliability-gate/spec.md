## ADDED Requirements

### Requirement: Unsigned eligible omitted-HMAC FRG evidence SHALL await attestation, not fail closed

A Factory Reliability Gate (FRG) score with HMAC omitted SHALL remain unsigned `pass: false`. That score SHALL NOT claim `pass: true`. When the bound pack is terminal and scoreboard and composition meet release-eligibility except HMAC is absent, the evidence SHALL be unsigned-eligible omitted-HMAC evidence. Structural eligibility SHALL NOT treat attested `pass: false` as structural fail when HMAC is the only missing piece.

`pipeline factory-release prepare` SHALL return `status: "awaiting_frg_attestation"` with closed unsigned artifact identities and the bound `loop_run_id` for that evidence. It SHALL NOT return `status: "failed"` or `defect_class: "frg_not_eligible"` for omitted HMAC only.

A ship-path FRG pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL treat that tick as attestation, not pack-fail. The composer SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a separate child that has the producer credential. That child SHALL NOT pass `--observations`. Prepare SHALL keep `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.

Pack-done SHALL still require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate. Real ineligible scoreboards (composition missing, required scenarios fail, wrong pack, engine-class over threshold) SHALL remain `frg_not_eligible` / pack-fail. The next identical unsigned eligible score SHALL not require a new mole issue or a human attestor command.

This requirement does not authorize `--skip-frg` as the ship path. It does not persist the key body in ship state. It does not commit `.agent-pipeline/frg/`.

#### Scenario: Omitted HMAC is awaiting attestation

- **WHEN** the bound pack loop is terminal
- **AND** scoreboard and composition meet release-eligibility except HMAC is absent
- **THEN** prepare SHALL return `status: "awaiting_frg_attestation"`
- **AND** it SHALL NOT return `status: "failed"`
- **AND** it SHALL NOT return `defect_class: "frg_not_eligible"`

#### Scenario: Unsigned latest.json stays pass false until attested

- **WHEN** prepare scores a structurally eligible terminal pack without the producer credential
- **THEN** `.agent-pipeline/frg/<X.Y.Z>/latest.json` MAY record `pass: false`
- **AND** that file SHALL NOT record `pass: true` until HMAC is present
- **AND** a composer SHALL NOT treat that `pass: false` as pack-fail

#### Scenario: Composer attests unsigned eligible pass false

- **WHEN** a ship-path composer sees unsigned-eligible omitted-HMAC `latest.json` `pass: false` for version `1.39.5`
- **AND** the bound pack `loop_run_id` is `L`
- **THEN** the composer SHALL invoke `pipeline factory-gate --for 1.39.5 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential
- **AND** that child SHALL NOT pass `--observations`
- **AND** the composer SHALL NOT mark the FRG pack phase failed on that tick

#### Scenario: Real ineligible score still fails closed

- **WHEN** a terminal pack score has composition missing or a required scenario fail
- **THEN** prepare SHALL NOT return `status: "awaiting_frg_attestation"` for omitted HMAC
- **AND** it SHALL return a failure status that names `frg_not_eligible` or the structural defect
- **AND** a composer SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Next identical unsigned eligible pack needs no new mole

- **WHEN** a later `Ship milestone` scores a terminal structurally eligible pack without HMAC in the prepare child
- **THEN** the same prepare status and composer attest law SHALL run `factory-gate --from-run`
- **AND** the ship SHALL NOT require a human attestor command or a new mole issue to finish the pack

## MODIFIED Requirements

### Requirement: Ship-path FRG pack composers SHALL wait until the bound pack loop is terminal

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL keep re-invoking the same `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live. The bound pack loop is live when its durable `lock.json` pid is alive or its ledger is not terminal. Wait-budget expiry while that loop is live SHALL NOT be pack-fail. The composer SHALL heartbeat running ship state on each wait tick. The composer SHALL NOT kill the pack loop. The composer SHALL NOT treat a CI-length poll cap (about 20 minutes) as the live-loop stop. Wait-budget expiry MAY be pack-fail only when the bound loop is not live. Unreadable or malformed `lock.json` or `ledger.json` SHALL NOT count as not-live. The composer SHALL keep re-invoking and heartbeat while liveness is unknown. The bound loop is not live only after a positive dead-or-missing lock pid and a positive terminal-or-missing ledger. Real pack-fail (failed or missing FRG that is not omitted-HMAC-only, `latest.json` `pass: false` after a terminal **ineligible** score, attestor child failure) SHALL still fail closed. `latest.json` `pass: false` caused only by omitted HMAC on a structurally eligible pack SHALL NOT be pack-fail. The next identical 20-minute live-loop wait SHALL not require a new mole issue.

This requirement does not raise the implementer 2400s cap. It does not authorize `--skip-frg` as the ship path. It does not change CI / release-PR check wait.

#### Scenario: Live bound loop outlives a short wait cap

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is live
- **AND** a numeric wait cap equal to a CI poll (about 20 minutes) expires
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT kill loop `L`

#### Scenario: Dead bound loop may still fail on wait budget

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live
- **AND** the not-live wait budget is exhausted
- **THEN** the composer MAY fail the pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Unreadable liveness state is not pack-fail

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** lock or ledger state for `L` is unreadable or malformed
- **AND** a numeric wait cap expires
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request

#### Scenario: Next identical 20-minute live pack needs no new mole

- **WHEN** a later 2-item factory-gate pack is still `in_progress` after 20 minutes
- **AND** the bound loop is live
- **THEN** the same composer wait law SHALL keep ticking prepare
- **AND** the ship SHALL NOT require a human re-detach or a new mole issue to finish the pack
