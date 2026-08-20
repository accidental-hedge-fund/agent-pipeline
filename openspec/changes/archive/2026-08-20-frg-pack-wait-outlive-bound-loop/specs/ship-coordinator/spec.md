## ADDED Requirements

### Requirement: In-engine ship FRG pack wait SHALL outlive the bound pack loop

In-engine `pipeline ship` SHALL keep re-invoking the same candidate `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live (`lock.json` pid alive or ledger not terminal). Wait-budget expiry while that loop is live SHALL NOT fail the ship. A short FRG tick cap (including 120 × 10s) plus a "retry the same ship command to resume" error SHALL NOT be pack-fail in that case. The coordinator SHALL keep the ship ledger FRG phase running and SHALL heartbeat on each wait tick. The coordinator SHALL NOT kill the pack loop. Wait-budget expiry MAY fail the FRG pack phase only when the bound loop is not live. Unreadable or malformed `lock.json` or `ledger.json` SHALL NOT count as not-live. The coordinator SHALL keep re-invoking and heartbeat while liveness is unknown. The bound loop is not live only after a positive dead-or-missing lock pid and a positive terminal-or-missing ledger. This requirement does not return from the FRG pack phase at the attestation checkpoint. It does not authorize `--skip-frg` as the default.

#### Scenario: In-engine live-loop wait expiry is not ship fail

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is live
- **AND** the numeric FRG tick cap is exhausted
- **THEN** `pipeline ship` SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT require a human to re-invoke the ship command solely to continue that live wait

#### Scenario: In-engine dead-loop wait expiry remains fail-closed

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live
- **AND** the not-live wait budget is exhausted
- **THEN** `pipeline ship` SHALL fail the FRG pack phase
- **AND** it SHALL NOT open or finish a release PR for that version on that evidence

#### Scenario: In-engine unreadable liveness at cap is not ship fail

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** lock or ledger state for `L` is unreadable or malformed
- **AND** the numeric FRG tick cap is exhausted
- **THEN** `pipeline ship` SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request

#### Scenario: Regression fails if in-engine wait treats live in_progress as terminal

- **WHEN** an automated check evaluates `in_progress` plus a live bound loop after N short FRG ticks at cap N
- **THEN** the decision SHALL be continue, not terminal fail
- **AND** the check SHALL fail if the adapter still throws a resume-to-retry error for that case
