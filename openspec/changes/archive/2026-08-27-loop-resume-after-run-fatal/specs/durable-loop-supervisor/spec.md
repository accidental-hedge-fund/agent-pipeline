## MODIFIED Requirements

### Requirement: Resume SHALL take over a run only when the prior supervisor is provably gone

`--resume <run-id>` SHALL attach a fresh supervisor to an existing run only when the prior holder is
provably gone by the durable store's existing rules — the lock is released, or the lock is held by a
dead process id on the same host and is recovered through the store's provably-dead recovery path.
Before resuming execution the supervisor SHALL run a reconciliation pass so it acts on verified live
truth, SHALL record a resume marker in the action-evidence trail, and SHALL continue from the
ledger's current position without creating a second run, lock, run-id, or run directory. When the
ledger carries `stop.reason = run_fatal`, the supervisor SHALL apply the run_fatal-resume
requirement (re-drive valid outstanding items or distinct refusal) instead of treating that stop as
the first cycle result. A run whose recorded contract or ledger schema id is outside the store's
supported set SHALL be refused before any takeover.

#### Scenario: A dead-holder run is resumed after reconciliation

- **WHEN** `--resume <run-id>` targets a run whose lock is held by a same-host dead pid
- **THEN** the supervisor SHALL recover the lock through the store's provably-dead path, run a
  reconciliation pass, and continue from the ledger's current position
- **AND** it SHALL record a resume marker in the action-evidence trail and create no second run,
  lock, or run directory

#### Scenario: A released-lock run is resumed

- **WHEN** `--resume <run-id>` targets a run whose prior supervisor released the lock
- **THEN** the supervisor SHALL acquire the lock and continue the run from its current ledger position

#### Scenario: A run_fatal stop is not a silent resume no-op

- **WHEN** `--resume <run-id>` targets a run whose lock is free and whose ledger carries
  `stop.reason = run_fatal`
- **THEN** the supervisor SHALL NOT complete the drive solely by re-emitting that stop with
  `resumed` true and zero item dispatches
- **AND** it SHALL apply the run_fatal-resume requirement at the same run id

## ADDED Requirements

### Requirement: Operator resume of a run_fatal stop SHALL re-drive valid outstanding items or refuse distinctly

The supervisor SHALL classify outstanding items against live observed identity when
`--resume <run-id>` attaches to a run whose ledger carries `stop.reason = run_fatal`, before it
emits `loop_drive_started` and before it dispatches any item. An item SHALL count as valid-outstanding
when all of the following hold: it is on the compiled contract; its ledger state is not
done, abandoned, or skipped; it is not under a current human-authority hold; live labels still
admit it under the existing loop precondition gate.

When at least one item is valid-outstanding, the supervisor SHALL supersede the `run_fatal` stop at
the same run id, run a fresh reconciliation, and re-drive those items through
`pipeline/loop-execution@1`. It SHALL NOT mint a second run, lock, run id, or run directory.

When no item is valid-outstanding, or live observation fails, the supervisor SHALL refuse with a
distinct non-success error that names the recorded stop `time`, `theme`, `item_id` when present, and
a recommended next command (audit the run; `--new-run` for the same selector). It SHALL NOT print
the terminal drive summary with `resumed` true and `dispatched` 0. It SHALL NOT emit
`loop_drive_started`. It SHALL NOT dispatch. It SHALL leave the original stop record in place.

A live drive that first records `run_fatal` SHALL still stop under existing recovery policy. The
supervisor SHALL NOT auto-retry that fatal without a new operator `--resume` invocation.

#### Scenario: Stale transient run_fatal with valid outstanding items re-drives in place

- **WHEN** `--resume <run-id>` targets a run stopped with `reason = run_fatal`
- **AND** at least one contract item is valid-outstanding (admitted label, not done or abandoned,
  no current human-authority hold)
- **THEN** the supervisor SHALL supersede that stop and dispatch at least one valid-outstanding
  item through `pipeline/loop-execution@1`
- **AND** the `run_id` SHALL be the resumed run's id (no second run directory)

#### Scenario: Fresh preflight runs before re-drive dispatch

- **WHEN** a `run_fatal` resume is eligible to re-drive
- **THEN** the supervisor SHALL reconcile live truth after the stop is superseded and before the
  first re-drive dispatch
- **AND** it SHALL NOT dispatch using only the pre-stop ledger snapshot as live truth

#### Scenario: Ineligible run_fatal resume refuses instead of zero-dispatch success

- **WHEN** `--resume <run-id>` targets a run stopped with `reason = run_fatal`
- **AND** no contract item is valid-outstanding
- **THEN** the command SHALL exit as a distinct error naming the recorded stop `time` and `theme`
- **AND** it SHALL NOT print a terminal drive summary with `resumed` true and `dispatched` 0
- **AND** the item-dispatch seam SHALL NOT be called
- **AND** `ledger.stop` SHALL remain the original `run_fatal` record

#### Scenario: Observe failure fail-closes to refusal

- **WHEN** `--resume <run-id>` targets a run stopped with `reason = run_fatal`
- **AND** live observation of outstanding items fails
- **THEN** the command SHALL refuse without clearing `ledger.stop`
- **AND** it SHALL NOT dispatch any item

#### Scenario: Re-drive that fatals again is a new stop, not a silent no-op

- **WHEN** a `run_fatal` resume re-drives a valid-outstanding item
- **AND** that dispatch records a new `run_fatal` stop
- **THEN** the new stop's `time` SHALL differ from the superseded stop's `time`
- **AND** the item-dispatch seam SHALL have been called for that drive

#### Scenario: Live-drive run_fatal policy is unchanged

- **WHEN** a live supervisor (not a resume of an already-recorded `run_fatal`) records a
  `run_fatal` class under existing recovery policy
- **THEN** it SHALL persist `stop.reason = run_fatal` and halt that drive
- **AND** it SHALL NOT auto-retry until a later operator `--resume` invocation

#### Scenario: Human-authority hold is not valid-outstanding

- **WHEN** `--resume <run-id>` targets a run stopped with `reason = run_fatal`
- **AND** every remaining non-done item is under a current human-authority hold
- **THEN** the command SHALL refuse distinctly
- **AND** it SHALL NOT re-drive those held items
