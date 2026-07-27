## ADDED Requirements

### Requirement: The `--new-run` surface SHALL be invocable end-to-end from the CLI

The `--new-run` modifier on the `loop` command SHALL survive unified per-command flag validation, so
that invoking `pipeline loop --new-run <selector>` reaches the supersession decision logic rather
than being rejected before any run logic executes. No CLI-layer guard SHALL treat `--new-run` as
incompatible with `loop`, and no error message SHALL describe `--new-run` as a separate command. The
operator SHALL NOT be required to hand-edit durable run state to exercise supersession.

#### Scenario: `pipeline loop --new-run` is not rejected as an incompatible flag

- **WHEN** the operator runs `pipeline loop --new-run` with a selector
- **THEN** the CLI SHALL NOT exit with code 2 for an unsupported-flag reason
- **AND** stderr SHALL NOT contain a message stating that `loop` cannot be combined with `--new-run`
- **AND** the loop command handler SHALL receive `newRun: true` and evaluate the supersession
  decision for the resolved selector

#### Scenario: Supersession refusals remain the only rejection path

- **WHEN** `--new-run` is invoked for a selector whose canonical run is not terminally stopped
- **THEN** the resulting refusal SHALL come from the supersession decision logic (directing the
  operator to resume the existing run), not from CLI flag validation
- **AND** no durable write SHALL be made and no new run directory SHALL be created

#### Scenario: Supersession semantics are unchanged by unblocking the flag

- **WHEN** `--new-run` supersedes a terminally-stopped canonical run after this change
- **THEN** the minted run id SHALL still be the deterministic supersession-chain id
- **AND** the linked `supersedes` / `superseded_by` pointers SHALL still be recorded
- **AND** the retired run's ledger, events, and run directory SHALL remain intact
