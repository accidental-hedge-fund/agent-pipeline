## ADDED Requirements

### Requirement: Ship-path FRG pack composers SHALL wait until the bound pack loop is terminal

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL keep re-invoking the same `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live. The bound pack loop is live when its durable `lock.json` pid is alive or its ledger is not terminal. Wait-budget expiry while that loop is live SHALL NOT be pack-fail. The composer SHALL heartbeat running ship state on each wait tick. The composer SHALL NOT kill the pack loop. The composer SHALL NOT treat a CI-length poll cap (about 20 minutes) as the live-loop stop. Wait-budget expiry MAY be pack-fail only when the bound loop is not live. Real pack-fail (failed or missing FRG, `latest.json` `pass: false` after a terminal score, attestor child failure) SHALL still fail closed. The next identical 20-minute live-loop wait SHALL not require a new mole issue.

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

#### Scenario: Next identical 20-minute live pack needs no new mole

- **WHEN** a later 2-item factory-gate pack is still `in_progress` after 20 minutes
- **AND** the bound loop is live
- **THEN** the same composer wait law SHALL keep ticking prepare
- **AND** the ship SHALL NOT require a human re-detach or a new mole issue to finish the pack
