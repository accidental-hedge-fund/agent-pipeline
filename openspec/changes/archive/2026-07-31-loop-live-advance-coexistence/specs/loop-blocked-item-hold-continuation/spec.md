## MODIFIED Requirements

### Requirement: A per-item needs-human hold SHALL NOT terminate a run that still has schedulable work

A per-item needs-human hold SHALL NOT, on its own, terminate the run. While at least one
other item can make progress, the supervisor SHALL exclude each held (`paused`/`waiting`)
item from the executable frontier — re-evaluated against the fresh reconciliation each
cycle, so a hold cleared by a human re-enters the frontier **only when no host-local advance
is still live for that item** — and SHALL continue selecting and dispatching the remaining
schedulable items. Clearing GitHub `pipeline:blocked` alone SHALL NOT re-admit an item into
the executable dispatch frontier while a live linked advance (or other host-local live-advance
evidence) for that item is non-terminal; in that case the item SHALL remain excluded from
full re-dispatch until the live advance is proven terminal or the live-advance probe reports
not live, and a durable record SHALL distinguish that deferred re-admission from an
unconditional hold clear. The supervisor SHALL reach its terminal outstanding-hold condition —
pausing and reporting `hold_outstanding=true` — only when no non-done item can make
progress: every remaining item is held or blocked and no schedulable item remains. When it
reaches that terminal outstanding-hold condition, the supervisor SHALL enumerate every held
item id in both the durable record and the `pipeline loop` command output, so an operator
sees exactly which items await a human. This enumeration SHALL be additive disclosure on the
existing terminal condition — it SHALL NOT introduce a new stop reason, alter which items
are considered done, or weaken the existing no-progress watchdog.

#### Scenario: A hold does not strand schedulable siblings

- **WHEN** one dispatched item is held for a needs-human blocker and one or more other items
  are schedulable
- **THEN** the run SHALL continue dispatching the schedulable items
- **AND** the run SHALL NOT reach a terminal condition solely because one item is held

#### Scenario: One blocked item plus N clean items dispatches the clean items

- **WHEN** a work-list contains one item already carrying `pipeline:blocked` and N clean,
  schedulable items
- **THEN** the supervisor SHALL hold the blocked item and dispatch the N clean items to their
  outcomes
- **AND** the run SHALL NOT record a `run_fatal` run stop for the blocked item

#### Scenario: The run pauses only when nothing can progress

- **WHEN** every remaining non-done item is held or blocked and no schedulable item remains
- **THEN** the supervisor SHALL reach its terminal outstanding-hold condition and report
  `hold_outstanding=true`
- **AND** the terminal report SHALL enumerate every held item id in the durable record and
  the `pipeline loop` output

#### Scenario: A held item re-enters the frontier when a human clears it and no advance is live

- **WHEN** a held item's `pipeline:blocked` label is cleared by a human between cycles
- **AND** no host-local advance is live for that item (no live lock, no non-terminal run-store,
  no non-terminal loop linkage)
- **THEN** the next reconciliation SHALL observe the item as no longer held for dispatch
- **AND** the supervisor SHALL re-admit it to the executable frontier rather than leaving it
  excluded

#### Scenario: Clearing blocked while a live advance exists does not re-admit for full dispatch

- **WHEN** a held item's `pipeline:blocked` label is cleared by a human between cycles
- **AND** a host-local advance is still live for that item (live lock, non-terminal run-store,
  or non-terminal loop linkage)
- **THEN** the supervisor SHALL NOT re-admit the item into a second full advance dispatch
- **AND** it SHALL NOT record a fatal double-dispatch failure for that item
- **AND** a durable record SHALL show that re-admission was deferred for coexistence rather
  than treating the item as unconditionally cleared for dispatch

## ADDED Requirements

### Requirement: Hold-clear reconciliation SHALL consult live-advance evidence before frontier re-admission

The hold-clear path that reopens needs-human holds after `pipeline:blocked` disappears SHALL
consult the same host-local live-advance probe (and any non-terminal loop advance linkage)
used by loop live-advance coexistence before moving an item to `pending` for full dispatch.
Label absence remains necessary for re-admission and is not sufficient while live evidence
exists. This requirement composes with, and does not weaken, the presence-based needs-human
hold model or the non-run-fatal continuation of schedulable siblings.

#### Scenario: Live operator advance blocks re-admit after unblock

- **WHEN** item `675` is held with source `pipeline_blocked_label`
- **AND** an operator clears `pipeline:blocked` while a separate host-local `/pipeline 675`
  advance is still live
- **THEN** hold-clear reconciliation SHALL NOT move `675` to an executable full-dispatch
  frontier state that starts a second advance
- **AND** the multi-item run SHALL NOT stop with `run_fatal` solely because of that coexistence

#### Scenario: Terminal live advance then allows re-admit

- **WHEN** item `675` had re-admission deferred because an advance was live
- **AND** a later cycle proves that advance terminal and `pipeline:blocked` remains absent
- **THEN** the supervisor MAY re-admit `675` under ordinary scheduler rules
- **AND** a subsequent dispatch, if any, is not classified as coexistence solely for the prior
  live period
