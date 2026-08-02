## ADDED Requirements

### Requirement: Pre-merge auto-fix attempt authority SHALL be the stage-attempt ledger

Pre-merge auto-fix SHALL perform at most one implementer attempt per authoritative candidate
identity using the stage-attempt ledger as the sole attempt authority. Trusted pipeline-attested
attempt-started / noop-clean PR comments and auto-fix commit-subject prefixes MAY be written and
hydrated as cross-host attestation inputs into the ledger, but callers SHALL NOT maintain a separate
parallel attempt book based only on sentinel regex scans or commit-subject inference disconnected
from the ledger API. Supervisor repair path identity (item, candidate, evidence fingerprint, action)
remains as already specified; child-stage and supervisor claims SHALL share that identity space.

#### Scenario: Restart honors ledger autofix claim without in-memory state

- **WHEN** a prior process claimed autofix for candidate head `H` via the ledger
- **AND** a new process resumes with empty in-memory flags
- **THEN** the pipeline SHALL NOT invoke the implementer again for that key
- **AND** SHALL reconcile the recorded attempt result before the next disposition

#### Scenario: Attested comment is hydration input not a second book

- **WHEN** an attested autofix-attempt comment exists for head `H`
- **THEN** ledger hydration MAY incorporate that comment as evidence
- **AND** subsequent eligibility checks SHALL go through the ledger API rather than a second
  independent sentinel-only store
