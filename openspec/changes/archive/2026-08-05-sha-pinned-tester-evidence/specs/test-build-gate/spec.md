## ADDED Requirements

### Requirement: Test/build gate execution SHALL emit SHA-pinned Tester evidence

The test/build gate path SHALL produce or update a `TesterEvidence` record for
the worktree HEAD SHA via the deterministic producer defined by the
`tester-evidence` capability when the gate runs (or explicitly skips because it
is disabled or no command is resolved) and a run/state directory is available
for recording. Command exit status, timeout, dirty-tree unavailability, and
skip/disable outcomes SHALL map into the Tester status taxonomy rather than
only a free-form `CommandRecord`. Existing gate blocking and fix-loop behavior
SHALL remain authoritative for advance/block routing; the Tester artifact is
the structured evidence form of that execution, not a parallel policy engine.

#### Scenario: passing gate run emits passed Tester evidence

- **WHEN** `runTestGate` completes a trusted clean-tree run that exits 0
- **AND** a run/state directory is provided for recording
- **THEN** a `TesterEvidence` record SHALL exist for the current HEAD SHA with
  `overall_status: "passed"`
- **AND** the resolved command identity SHALL appear in `commands`

#### Scenario: failing gate run emits failed Tester evidence

- **WHEN** the test/build command exits non-zero under a trusted run
- **AND** a run/state directory is provided
- **THEN** the `TesterEvidence` record for that HEAD SHA SHALL have a non-pass
  `overall_status` of `"failed"` (or `"timeout"` / `"tooling_failure"` when so
  classified)
- **AND** bounded redacted output SHALL be retained on the command row

#### Scenario: disabled gate emits disabled evidence when recording is available

- **WHEN** `cfg.test_gate.enabled` is false
- **AND** the producer is invoked with a run/state directory
- **THEN** the emitted `TesterEvidence` SHALL have `overall_status: "disabled"`
- **AND** no test/build command SHALL be executed

#### Scenario: dirty product tree unavailability is explicit

- **WHEN** the gate hard-blocks before running because of product-relevant
  uncommitted changes
- **AND** recording is available
- **THEN** the Tester evidence for that attempt SHALL use `unavailable` (or
  equivalent non-pass) with a reason naming the dirty-tree trust failure
- **AND** SHALL NOT claim `"passed"`

#### Scenario: recording absent remains non-fatal for gate outcome

- **WHEN** unit tests or callers invoke the gate without a state/run directory
- **THEN** the gate outcome (pass/block/skip) SHALL still be computed as today
- **AND** absence of a written artifact SHALL NOT alone invert the gate’s
  pass/fail decision for that in-process call
