# stage-attempt-ledger Specification

## Purpose
TBD - created by archiving change pre-merge-reconcile-and-converge-ledger. Update Purpose after archive.
## Requirements
### Requirement: Stage recovery attempts SHALL use one durable ledger API

The engine SHALL provide a single stage-attempt ledger API that is the sole production authority
for stage-local recovery one-shots previously stored across worktree marker files, runDir JSON
(`pre-merge-ci-recovery.json`), autofix comment sentinels as sole books, commit-subject prefix
inference as sole books, and process-local in-memory flags. Callers SHALL read and write attempts
only through this API (or a thin facade that delegates to it). The ledger SHALL extend the shipped
autonomous recovery-attempt record family rather than introduce a second parallel attempt schema.

#### Scenario: Pre-merge CI one-shots hydrate from the ledger

- **WHEN** the pre-merge CI gate evaluates whether rebase, workflow re-run, archive-fail recovery,
  or assertion-fix has already been attempted for head SHA `H`
- **THEN** it SHALL query the stage-attempt ledger for action keys bound to `H`
- **AND** SHALL NOT require `pre-merge-ci-recovery.json` to be present as the authority

#### Scenario: In-memory flags alone are not durable authority

- **WHEN** a process restarts with empty in-memory recovery flags
- **AND** the ledger already records a completed or started attempt for `(H, action)`
- **THEN** the gate SHALL treat that action as already attempted for `H`
- **AND** SHALL NOT re-fire the side effect solely because the in-memory flag was lost

#### Scenario: No second attempt schema is introduced

- **WHEN** the stage-attempt ledger and autonomous recovery controller attempt stores are inspected
- **THEN** stage actions SHALL share the recovery-attempt record family (extended fields allowed)
- **AND** the engine SHALL NOT persist a competing private attempt schema as production authority

---

### Requirement: Attempt records SHALL carry status, reason, budget, error, schedule, and terminal outcome

Each ledger attempt record SHALL include at least: identity key material (`headSha` and `action`,
plus item/candidate/run/evidence bindings when the action is supervisor-shared), action status,
typed reason (closed vocabulary compatible with #760 where applicable), attempt budget remaining
for the class, last error (bounded, non-sensitive), `next_attempt_at` / `not_before` eligibility
time when deferred, an idempotency key, and a terminal outcome among completed success, failed,
or explicitly superseded. Action execution and hydration MUST remain idempotent across process
restart.

#### Scenario: Claim before side effect persists started status

- **WHEN** a stage recovery action is about to execute an external side effect
- **THEN** the ledger SHALL durably record the attempt with status/outcome `started` (or the
  shipped equivalent) and charge budget before the side effect
- **AND** the record SHALL carry the idempotency key for that `(headSha, action)` identity

#### Scenario: Restart after started reconciles without free replay

- **WHEN** a process dies after persisting `started` and before completion
- **AND** a resumed process hydrates the same attempt key
- **THEN** it SHALL reconcile live postconditions against that attempt
- **AND** SHALL NOT create an uncharged second attempt for the same key

#### Scenario: Terminal outcomes are exhaustive for started attempts

- **WHEN** a previously `started` attempt is later observed by reconcile
- **THEN** the ledger path SHALL drive it to completed success, failed, or explicitly superseded
- **AND** SHALL NOT leave `started` as a permanent terminal state across successful reconciliation

---

### Requirement: Ledger hydration SHALL prefer cross-host-safe authoritative evidence

Hydration for raw advance and durable-loop entry points SHALL share the same ledger API. When
host-local run state is missing, hydration SHALL use GitHub-authored attestation (attested pipeline
comments and commit subjects as migration/attestation inputs) consistent with cross-host-safe
patterns. Host-local marker files SHALL NOT override fresher GitHub-attested terminal outcomes for
the same attempt key.

#### Scenario: Other-host resume honors attested attempt

- **WHEN** host A claimed and completed an autofix or CI recovery attempt for head `H`
- **AND** host B resumes without host A's runDir JSON
- **AND** GitHub-attested evidence for that attempt key is present
- **THEN** host B's hydration SHALL treat the action as already attempted for `H`
- **AND** SHALL NOT re-fire the side effect

#### Scenario: Stale host-local file does not win over GitHub terminal evidence

- **WHEN** a host-local recovery file lacks an attempt that GitHub-attested ledger evidence shows
  as completed for `(H, action)`
- **THEN** hydration SHALL honor the GitHub-attested completed outcome
- **AND** SHALL NOT treat the missing local file as a free retry

---

### Requirement: Retired mechanisms SHALL NOT be production attempt authorities

After this capability lands, the engine SHALL NOT treat the following as sole production authorities
for stage recovery one-shots: the untracked worktree file `.pipeline-rebase-attempted`;
`pre-merge-ci-recovery.json` field sets; pre-merge autofix comment sentinels scanned without ledger
hydration; commit-subject prefix inference alone; or in-memory `repairAttempted` /
`noRunRecoveryAttemptedForSha` flags alone. The engine SHALL NOT write `.pipeline-rebase-attempted`
as an attempt marker on new runs. Legacy reads MAY hydrate into the ledger once during migration.

#### Scenario: Engine does not write the rebase attempt marker file

- **WHEN** pre-merge performs a rebase recovery attempt for head `H`
- **THEN** the durable attempt SHALL be recorded in the stage-attempt ledger
- **AND** the engine SHALL NOT create `.pipeline-rebase-attempted` as the attempt authority

#### Scenario: CI recovery without pre-merge-ci-recovery.json still bounds attempts

- **WHEN** durable ledger state records re-run attempted for head `H`
- **AND** `pre-merge-ci-recovery.json` is absent
- **THEN** the CI gate SHALL NOT re-run workflows again for `H`
- **AND** SHALL continue the ladder or escalate

#### Scenario: Autofix sentinel scan alone is insufficient without ledger identity

- **WHEN** pre-merge evaluates autofix eligibility for candidate `H`
- **THEN** attempt authority SHALL come from ledger hydration (which MAY incorporate attested
  comments as inputs)
- **AND** callers SHALL NOT maintain a separate parallel attempt book based only on sentinel regex
  scans disconnected from the ledger API

