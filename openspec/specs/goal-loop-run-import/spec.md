# goal-loop-run-import Specification

## Purpose
TBD - created by archiving change absorb-goal-loop-core. Update Purpose after archive.
## Requirements
### Requirement: Pipeline SHALL import runs created by the external goal-loop skill

Pipeline SHALL resolve a requested run id in its own durable store first and, on a miss, SHALL
search the documented legacy goal-loop state roots read-only. On finding a legacy run whose
contract and ledger schema ids are within the documented supported set, Pipeline SHALL import
it into the native store under the same run id and resume it from the imported state. A legacy
run whose schema ids are outside the supported set — older or newer — SHALL be refused with a
message naming both the found ids and the supported ids, and SHALL NOT be partially imported.

#### Scenario: A mid-run legacy run resumes after import

- **WHEN** a resume targets a legacy run whose items include pending, in-progress, and blocked
  states
- **THEN** the run SHALL be imported and resumed from those same item states
- **AND** the run id SHALL be unchanged

#### Scenario: An unsupported legacy schema is refused

- **WHEN** the legacy run records a contract or ledger schema id outside the supported set
- **THEN** the import SHALL fail naming the found and the supported ids
- **AND** no native run directory SHALL be created

#### Scenario: The native store takes precedence

- **WHEN** a run id exists in both the native store and a legacy root
- **THEN** the native run SHALL be used
- **AND** the legacy root SHALL not be read for that run

---

### Requirement: Import SHALL preserve the run's durable state in full

Import SHALL carry over the contract's repository, selector, objective, worktree policy, done
definition, authority grants, recovery budgets, stop limits, and item ordering; and the
ledger's per-item states, per-item history, blocked themes, remaining recovery budgets,
consecutive-blocked count, merge barrier, last reconciliation, terminal stop record, and last
native-goal check. The event and decision logs SHALL be carried over preserving their existing
sequence and order. The canonical hash recorded by the legacy run SHALL be preserved verbatim
and SHALL NOT be recomputed, and the imported contract SHALL record the legacy schema id it
originated from.

#### Scenario: Item state and history survive import

- **WHEN** a legacy run with per-item history, blocked themes, and a partially spent recovery
  budget is imported
- **THEN** the imported ledger SHALL report the same item states, the same history entries in
  the same order, the same blocked themes, and the same remaining budgets

#### Scenario: A merge barrier survives import

- **WHEN** a legacy run carrying an unmet merge barrier is imported
- **THEN** the imported run SHALL still refuse a transition into in-progress until the barrier
  is cleared by reconciliation

#### Scenario: The canonical hash is preserved, not recomputed

- **WHEN** a legacy run is imported
- **THEN** the imported contract's canonical hash SHALL equal the legacy value byte for byte
- **AND** the imported contract SHALL record the legacy contract schema id as its provenance

#### Scenario: Logs keep their ordering

- **WHEN** a legacy run's event and decision logs are imported
- **THEN** the imported logs SHALL contain the same records in the same order with their
  original sequence numbers

---

### Requirement: Import SHALL NOT modify the legacy run's durable documents

Import SHALL treat the legacy run's contract, ledger, event log, and decision log as read-only
and SHALL leave them byte-identical. The only write import SHALL make into a legacy run
directory is a single marker recording that the run has been superseded, by which native run,
and when.

#### Scenario: Legacy documents are untouched

- **WHEN** a legacy run is imported
- **THEN** its contract, ledger, event log, and decision log SHALL be byte-identical to their
  pre-import content

#### Scenario: Exactly one legacy write

- **WHEN** the import is exercised through the injected filesystem seam
- **THEN** exactly one write into the legacy run directory SHALL be recorded, and it SHALL be
  the superseded marker

---

### Requirement: Import SHALL refuse a legacy run that may still be actively driven

Import SHALL refuse, performing no write at all, when the legacy run holds a lock whose holder
is live on this host, or whose liveness cannot be verified because it was recorded on another
host. Import SHALL also refuse when the legacy run already carries a superseded marker, so a
run is never imported twice into two divergent native runs. Each refusal SHALL name the reason
and, for a held lock, the recorded holder.

#### Scenario: A live legacy lock blocks import

- **WHEN** the legacy run's lock records this host and a live process id
- **THEN** the import SHALL be refused naming the holder
- **AND** no native run directory and no marker SHALL be written

#### Scenario: An unverifiable cross-host lock blocks import

- **WHEN** the legacy run's lock records a different hostname
- **THEN** the import SHALL be refused rather than assuming the holder is gone

#### Scenario: A second import is refused

- **WHEN** import targets a legacy run that already carries a superseded marker
- **THEN** it SHALL be refused naming the native run that superseded it
- **AND** no second native run SHALL be created

---

### Requirement: The migration window SHALL be bounded by an observable removal condition

Pipeline SHALL report, as part of its preflight diagnostics, how many importable legacy runs
exist and how many of them are in a non-terminal state. Import support SHALL be retained until
that report shows no non-terminal legacy run and at least one full release cycle has elapsed
since import support shipped. Removal of import support SHALL be a separately approved change
citing that report, and SHALL NOT be performed implicitly.

#### Scenario: Diagnostics report the migration backlog

- **WHEN** preflight diagnostics run on a host with legacy runs present
- **THEN** they SHALL report the number of importable legacy runs and how many are
  non-terminal

#### Scenario: Diagnostics pass with no legacy runs

- **WHEN** preflight diagnostics run on a host with no legacy state root present
- **THEN** the migration report SHALL state that there are none
- **AND** the diagnostics SHALL NOT fail on that basis

#### Scenario: Removal is evidence-gated

- **WHEN** removal of import support is proposed
- **THEN** it SHALL cite a diagnostics report showing no non-terminal legacy runs

