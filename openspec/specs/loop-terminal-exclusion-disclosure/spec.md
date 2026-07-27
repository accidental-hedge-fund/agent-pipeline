# loop-terminal-exclusion-disclosure Specification

## Purpose
TBD - created by archiving change loop-terminal-exclusion-disclosure. Update Purpose after archive.
## Requirements
### Requirement: The loop terminal summary SHALL distinguish a fully-completed run from a run whose items were merely excluded

The durable loop's terminal summary SHALL report `all_done` (the drive result's `allDone`)
as true only when every work-list item reached a terminal-**successful** state (done or
abandoned). A run that resolves with one or more items merely **excluded** — undispatchable
under the precondition stage gate — SHALL NOT report `all_done` as true. The terminal
summary SHALL additionally carry a `completion` classifier naming the resolved shape:
`all_done` when no item was excluded, `partial_excluded` when at least one item reached a
terminal-successful state and at least one item was excluded, and `none_dispatchable` when
zero items were dispatched and at least one item was excluded. For a terminal condition that
is not a resolution — a recorded stop or an outstanding needs-human hold — `completion`
SHALL be null and the existing stop/hold disclosures SHALL be unchanged. The classification
SHALL be a deterministic function of the resolving cycle's exclusion set and the run
ledger's item states, so a unit test drives it with no real network, git, or subprocess call.

#### Scenario: An all-excluded run does not report all_done

- **WHEN** a run resolves with every work-list item precondition-excluded and none dispatched
- **THEN** the terminal summary SHALL report `all_done` as false
- **AND** it SHALL report `completion` as `none_dispatchable`

#### Scenario: A genuinely completed run still reports all_done

- **WHEN** a run resolves with every work-list item at a terminal-successful state and no item
  excluded
- **THEN** the terminal summary SHALL report `all_done` as true
- **AND** it SHALL report `completion` as `all_done`

#### Scenario: A mixed run is reported as partially excluded

- **WHEN** a run resolves with at least one item at a terminal-successful state and at least one
  item excluded
- **THEN** the terminal summary SHALL report `all_done` as false
- **AND** it SHALL report `completion` as `partial_excluded`

#### Scenario: A stop or hold leaves the classifier null

- **WHEN** a run reaches a terminal condition that is a recorded stop or an outstanding
  needs-human hold
- **THEN** the terminal summary SHALL report `completion` as null
- **AND** the existing `stop`, `hold_outstanding`, and held-item disclosures SHALL be unchanged

#### Scenario: An empty work list is not reported as undispatchable

- **WHEN** a run resolves with zero work-list items, and therefore zero dispatched and zero
  excluded
- **THEN** the terminal summary SHALL report `completion` as `all_done`
- **AND** it SHALL NOT report `none_dispatchable`

---

### Requirement: The terminal summary SHALL carry machine-readable dispatch and exclusion accounting

The `pipeline loop` terminal JSON and the supervisor drive result SHALL carry, alongside the
existing keys, the number of items dispatched to a terminal-successful state, the number of
items excluded, the excluded item ids, and the dominant exclusion reason. The dominant
exclusion reason SHALL be the exclusion reason recorded for the greatest number of excluded
items, with ties broken by a stable ordering of the reason strings, so identical run state
always renders an identical summary; it SHALL be null when no item was excluded. The
excluded set SHALL be derived from the exclusion classification of the cycle that resolves
the run — not accumulated across cycles — so an item excluded early and later triaged into
the frontier is reported as dispatched, not excluded. The dispatched count SHALL be derived
from the run ledger's item states so a resumed run reports the whole run's accounting rather
than only the cycles the current process drove. Needs-human held items SHALL NOT be counted
as excluded; they keep their own separate disclosure. The new keys SHALL be additive to the
existing terminal payload, leaving `schema_version` and every existing key's name and type
unchanged.

#### Scenario: The all-excluded run reports counts and reason

- **WHEN** a run resolves with two items excluded for a missing `pipeline:ready` precondition and
  none dispatched
- **THEN** the terminal JSON SHALL report a dispatched count of zero and an excluded count of two
- **AND** it SHALL name both excluded item ids and the dominant exclusion reason recorded for them

#### Scenario: A completed run reports a null exclusion reason

- **WHEN** a run resolves with no item excluded
- **THEN** the terminal JSON SHALL report an excluded count of zero
- **AND** it SHALL report the dominant exclusion reason as null and an empty excluded item id list

#### Scenario: A resumed run counts work done before the resume

- **WHEN** a run is resumed and resolves with items that reached a terminal-successful state in
  cycles driven before the resume
- **THEN** the dispatched count SHALL include those items

#### Scenario: A held item is not counted as excluded

- **WHEN** a run carries an item held for a needs-human blocker alongside precondition-excluded
  items
- **THEN** the held item SHALL NOT be counted in the excluded count or listed in the excluded item
  ids
- **AND** the existing held-item disclosure SHALL still name it

#### Scenario: Existing terminal keys are unchanged

- **WHEN** the terminal summary is emitted
- **THEN** the accounting keys SHALL be added alongside the existing keys
- **AND** `schema_version` and every pre-existing key's name and type SHALL be unchanged

---

### Requirement: The loop command SHALL surface exclusions on its own output and exit distinctly when nothing was dispatchable

The `pipeline loop` command SHALL print a human-readable line naming the number of excluded
items, the excluded item ids, and the dominant exclusion reason whenever a run resolves with
at least one excluded item — on the command's own output, without requiring a separate
`--audit` invocation. The command SHALL exit with a distinct exit code, separate from both
the success code and the existing stop/hold failure code, when the run resolves
`none_dispatchable`; it SHALL exit with the success code for an `all_done` or
`partial_excluded` resolution, and SHALL keep its existing failure exit code for a recorded
stop or an outstanding hold.

#### Scenario: The operator sees the exclusion without running audit

- **WHEN** a run resolves with two items excluded for a missing `pipeline:ready` precondition
- **THEN** `pipeline loop` SHALL print a line naming the excluded count, the excluded item ids,
  and the dominant exclusion reason
- **AND** that disclosure SHALL NOT require a separate `--audit` invocation

#### Scenario: Nothing dispatchable exits with its own code

- **WHEN** a run resolves `none_dispatchable`
- **THEN** `pipeline loop` SHALL exit with a code distinct from both its success code and its
  stop/hold failure code

#### Scenario: A partially excluded run still succeeds

- **WHEN** a run resolves `partial_excluded`
- **THEN** `pipeline loop` SHALL exit with its success code
- **AND** it SHALL still print the excluded-count line

#### Scenario: A stop keeps its existing exit code

- **WHEN** a run ends in a recorded stop or an outstanding needs-human hold
- **THEN** `pipeline loop` SHALL exit with its existing failure exit code unchanged

---

### Requirement: The disclosure SHALL NOT alter exclusion, scheduling, or stop semantics

This change SHALL be observability-only. The precondition stage gate SHALL continue to
exclude the same items for the same reasons: non-fatally, re-evaluated against live truth on
each reconciliation pass, consuming no recovery budget, recording no run stop, and admitting
an item that is triaged into the required stage mid-run on a later cycle. The run SHALL
continue to resolve — rather than spin toward the no-progress watchdog — when every item is
done, abandoned, or excluded. No pipeline stage label SHALL be written and no merge SHALL be
performed on any path introduced by this change.

#### Scenario: Exclusion remains non-fatal and re-evaluated

- **WHEN** an item is excluded for a missing precondition stage and later observed at the
  required stage
- **THEN** the item SHALL be admissible on a later cycle without recompiling or restarting the run
- **AND** the exclusion SHALL have consumed no recovery budget and recorded no run stop

#### Scenario: An all-excluded run still resolves rather than spinning

- **WHEN** every work-list item is excluded
- **THEN** the run SHALL reach its resolved terminal condition
- **AND** it SHALL NOT spin toward the no-progress watchdog stop

#### Scenario: No label write and no merge

- **WHEN** the terminal summary is computed and emitted
- **THEN** no pipeline stage label SHALL be written
- **AND** no merge SHALL be performed

