# durable-run-two-item-live-pilot Specification

## Purpose
TBD - created by archiving change durable-run-two-item-live-pilot. Update Purpose after archive.
## Requirements
### Requirement: The pilot SHALL drive a bounded two-item dependent run under single active item

The two-item live pilot SHALL define a reproducible run of exactly two items — item **A** and item
**B** — where B declares an `external_depends_on` edge on A, driven through the durable loop
supervisor under a contract with `max_active_items: 1`. The pilot SHALL exercise this run through the
shipped composed runtime (the supervisor cycle, reconciliation, dependency verification, recovery,
and the evidence projection) and SHALL NOT introduce a second ledger, lock, run directory, or a new
external mutation path. At most one item SHALL be active at any point in the run.

#### Scenario: The dependent item cannot start before its producer

- **WHEN** the pilot run begins with item A not yet done and B declaring `external_depends_on: [A]`
- **THEN** item B SHALL NOT be selected to start
- **AND** at most one item SHALL be active in any cycle

#### Scenario: The pilot uses the shipped runtime, not a parallel one

- **WHEN** the pilot drives the run
- **THEN** every durable write SHALL be issued through the engine into the single authoritative run
  directory
- **AND** no second ledger, lock, or run-id namespace SHALL be created

---

### Requirement: The pilot SHALL exercise a recoverable blocker resolved by resuming the same item

The pilot SHALL drive item A into a `blocked` transition carrying a recoverable member of the
`DurableBlockerClass` set, then exercise the recovery path back to `in_progress` and a supervisor
resume that continues that **same** item A. On resume the supervisor SHALL run a reconciliation pass
and SHALL append a `resume` marker to the run's action-evidence trail. The pilot SHALL NOT start a
second or freshly-created item in place of the recovered item A.

#### Scenario: A recoverable blocker is recorded then recovered

- **WHEN** item A transitions into `blocked` with a recoverable `DurableBlockerClass` and is then
  recovered
- **THEN** item A SHALL return to `in_progress` rather than being abandoned
- **AND** the recovery SHALL be recorded in the ledger history

#### Scenario: Resume continues the same item and marks the trail

- **WHEN** the supervisor resumes the run after item A's recovery
- **THEN** it SHALL run a reconciliation pass before continuing
- **AND** it SHALL append a `resume` action-evidence marker
- **AND** it SHALL continue item A without starting a second item for A

---

### Requirement: The pilot SHALL gate the dependent item behind a verified merge-refresh barrier

The pilot SHALL prove that item B remains ineligible to start while A's external dependency resolves
to `pending` from live truth, and that B becomes eligible to start only on the first cycle after a
reconciliation pass observes A's linked pull request `merged` through the engine-owned observation
seam. Barrier resolution SHALL derive from verified live truth only: a caller-supplied claim that A
is merged, absent a supporting live observation, SHALL NOT release item B.

#### Scenario: The dependent item is held until the producer is observed merged

- **WHEN** A's linked pull request is observed unmerged and A's dependency is therefore `pending`
- **THEN** item B SHALL NOT be eligible to start

#### Scenario: The dependent item is released on the first cycle after the merge is observed

- **WHEN** a reconciliation pass observes A's linked pull request `merged` in live truth
- **THEN** A's external dependency SHALL resolve to `satisfied`
- **AND** item B SHALL become eligible to start on the first subsequent cycle, subject to the
  single-active-item invariant

#### Scenario: A caller claim cannot release the barrier

- **WHEN** a caller supplies a claim that A is `merged` with no supporting live observation
- **THEN** item B SHALL NOT be released
- **AND** the barrier SHALL clear only once verified live truth reports A merged

---

### Requirement: The pilot SHALL emit a derived evidence bundle covering every exercised behavior

The pilot SHALL emit exactly one evidence bundle for the run that references the concrete recorded
durable artifacts proving each exercised behavior: item A and B ledger history, the action-evidence
timeline including the `resume` marker, the sequence-numbered reconciliation records, the merge
observation that cleared the merge-refresh barrier, and the run's terminal condition. The bundle
SHALL be derived from recorded run state and SHALL NOT be a free-form narrative summary; each of the
five exercised behaviors (recoverable blocker, same-item resume, merge-refresh barrier, evidence
reporting, no duplicate external action) SHALL be locatable within it.

#### Scenario: The bundle references recorded artifacts, not prose

- **WHEN** the pilot emits its evidence bundle
- **THEN** the bundle SHALL reference the ledger history, action-evidence timeline, reconciliation
  records, and terminal condition drawn from recorded run state
- **AND** each of the five exercised behaviors SHALL be locatable within it

---

### Requirement: The pilot SHALL perform no duplicate external action

The pilot SHALL prove that replaying an already-applied cycle — a crash-and-resume, or a redundant
reconciliation over an item already observed `merged` — records **zero** additional external
mutations. No duplicate pull request, issue, label write, or merge SHALL be recorded through the
injected seam for a cycle whose effect has already been applied.

#### Scenario: Replaying an applied cycle mutates nothing new

- **WHEN** the pilot replays a cycle whose external effect has already been applied (crash-and-resume
  or a redundant reconciliation over a `merged` item)
- **THEN** zero additional external mutations SHALL be recorded through the injected seam
- **AND** no duplicate pull request, issue, label write, or merge SHALL result

---

### Requirement: The pilot SHALL be verified hermetically in CI through injected seams

The pilot SHALL include a composition simulation that drives the entire
A → blocker → recovery/resume → merge-refresh barrier → B → terminal sequence through the existing
injected supervisor and reconciliation-observation seams, performing zero real network, git, and
subprocess calls. Every assertion the simulation makes about a composed behavior SHALL be proven to
bite — defeating the behavior SHALL cause the corresponding assertion to fail.

#### Scenario: The simulation runs end to end with no real I/O

- **WHEN** the composition simulation runs from `core/` with no outbound network access
- **THEN** it SHALL drive the run to its expected terminal condition through injected fakes
- **AND** zero real network, git, and subprocess calls SHALL be recorded

#### Scenario: Each composition assertion bites

- **WHEN** a composed behavior under test (same-item resume, the merge-refresh barrier, or the
  no-duplicate-external-action invariant) is defeated
- **THEN** the corresponding simulation assertion SHALL fail

---

### Requirement: The live pilot SHALL be documented as a runbook and executed with a captured evidence bundle

The pilot SHALL provide an operator-facing runbook documenting the exact steps to run the real
two-item pilot against a GitHub repository — including how the recoverable blocker is induced and how
a human performs item A's merge (the pipeline never merges) — and an evidence-bundle artifact
contract mapping each of the five exercised behaviors to the concrete recorded artifacts the live run
must capture. The real live two-item pilot SHALL be executed per the runbook and its captured
evidence bundle SHALL demonstrate all five behaviors and be linked from issue #515.

#### Scenario: The runbook pins the human merge and the evidence contract

- **WHEN** an operator follows the live-pilot runbook
- **THEN** the runbook SHALL specify that a human performs item A's merge and that the pilot only
  observes it
- **AND** the runbook SHALL enumerate the evidence-bundle artifacts required for each of the five
  exercised behaviors

#### Scenario: The executed live pilot produces a linked evidence bundle

- **WHEN** the real two-item live pilot has been executed
- **THEN** its captured evidence bundle SHALL demonstrate the recoverable blocker, same-item resume,
  merge-refresh barrier, evidence reporting, and no-duplicate-external-action behaviors
- **AND** the bundle SHALL be linked from issue #515

