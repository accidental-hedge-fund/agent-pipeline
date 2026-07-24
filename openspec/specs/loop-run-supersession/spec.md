# loop-run-supersession Specification

## Purpose
TBD - created by archiving change loop-precondition-stage-gate. Update Purpose after archive.
## Requirements
### Requirement: A terminally-stopped run SHALL be supersedable into a fresh run for the same selector via an audited CLI surface

The pipeline CLI SHALL expose a `--new-run` modifier on the `loop` command that, for a given
selector, starts a **fresh** durable run for the same resolved item list when the canonical
run for that selector is in a terminal stopped state. Superseding SHALL mint a new run id
that is itself deterministic and re-resumable (the canonical `workListRunId` extended by a
deterministic supersession suffix derived from the existing supersession chain, never from a
clock or randomness), initialize the fresh run through the durable engine into its own run
directory, and drive it. The operator SHALL NOT be required to move, delete, or otherwise
hand-edit any durable run directory to unwedge a terminally-stopped selector.

#### Scenario: `--new-run` starts a fresh run for a terminally-stopped selector

- **WHEN** the canonical run for a selector is in a terminal stopped state and the operator
  runs `pipeline loop --new-run` with that selector
- **THEN** a fresh durable run SHALL be initialized under a new, deterministic run id
- **AND** the fresh run SHALL be driven from its own run directory
- **AND** no existing run directory SHALL be moved, deleted, or hand-edited

#### Scenario: The superseding run id is deterministic and re-resumable

- **WHEN** `--new-run` mints a run id for a selector whose retired run it supersedes
- **THEN** the new run id SHALL be a deterministic function of the selector and the existing
  supersession chain
- **AND** re-invoking the same superseding run SHALL resume it rather than create a duplicate

---

### Requirement: Supersession SHALL record linked pointers and preserve the retired run's audit trail

A superseding run SHALL record a `supersedes` pointer naming the retired run id, and the
retired run SHALL record a `superseded_by` pointer naming the new run id, so the chain from a
retired run to its replacement is durably auditable. The retired run's ledger, events, and
run directory SHALL remain intact and readable after supersession. `--audit` over either run
SHALL surface its place in the supersession chain.

#### Scenario: Linked supersedes / superseded_by pointers are recorded

- **WHEN** a fresh run supersedes a terminally-stopped run
- **THEN** the fresh run SHALL record `supersedes` naming the retired run id
- **AND** the retired run SHALL record `superseded_by` naming the fresh run id

#### Scenario: The retired run's audit trail is preserved

- **WHEN** a run has been superseded
- **THEN** its ledger, events, and run directory SHALL remain intact and readable
- **AND** an audit over the retired run SHALL still surface its recorded terminal stop

---

### Requirement: Supersession SHALL be refused for a run that is not terminally stopped

`--new-run` SHALL be refused with a clear, non-mutating error when the canonical run for the
selector is not in a terminal stopped state — including when the run is still active,
resumable, awaiting a human hold, or already complete. A run that can be resumed SHALL be
resumed, not superseded. A refused supersession SHALL make no durable write and SHALL create
no new run directory.

#### Scenario: Superseding an active run is refused

- **WHEN** the operator runs `pipeline loop --new-run` for a selector whose canonical run is
  still active or resumable (not terminally stopped)
- **THEN** the command SHALL exit non-zero with an error directing the operator to resume the
  existing run
- **AND** no new run directory SHALL be created and no durable write SHALL be made

#### Scenario: Superseding a run with no terminal stop is refused

- **WHEN** the operator runs `pipeline loop --new-run` for a selector whose canonical run has
  recorded no terminal stop
- **THEN** the command SHALL be refused without mutating durable state

