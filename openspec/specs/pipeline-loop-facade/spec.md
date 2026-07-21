# pipeline-loop-facade Specification

## Purpose
TBD - created by archiving change pipeline-loop-facade. Update Purpose after archive.
## Requirements
### Requirement: `pipeline:loop` SHALL be the canonical durable multi-item run command on both hosts

The host packaging SHALL expose a `loop` operation as `/pipeline:loop` on the Claude
host and `$pipeline:loop` on the Codex host, generated from the same single-source
operation list as every other `pipeline:<command>` entry. The two hosts SHALL accept an
identical argument contract with exactly these selector and mode arguments:
`--milestone <name>`, `--label <label>`, `--range <spec>`, `--roadmap-slice <slice>`,
an explicit issue list (one or more issue numbers), `--resume <run-id>`, and `--audit`.
Selector arguments SHALL be mutually exclusive with `--resume`, and `--audit` SHALL be
a read-only mode that performs no mutation.

#### Scenario: Both hosts expose the loop entry

- **WHEN** the generated Claude command surface and the generated Codex agent surface
  are enumerated
- **THEN** each SHALL contain exactly one `pipeline:loop` entry
- **AND** the two entries SHALL declare the same argument contract

#### Scenario: Each selector form parses to a normalized selector

- **WHEN** `pipeline:loop` is invoked with `--milestone v2`, `--label backlog`,
  `--range 400-420`, `--roadmap-slice next`, or an explicit list `418 419 420`
- **THEN** argument normalization SHALL produce a selector whose type is respectively
  `milestone`, `label`, `work-list`, `roadmap-slice`, and `work-list`, with the
  corresponding value
- **AND** an invocation combining a selector with `--resume` SHALL be rejected with a
  non-zero exit and a message naming the conflict

#### Scenario: Audit mode is read-only

- **WHEN** `pipeline:loop --audit` is invoked for an existing run
- **THEN** it SHALL print that run's status/report from the durable store
- **AND** it SHALL perform no write to the ledger, no lock acquisition, and no GitHub
  mutation

---

### Requirement: Equivalent invocations on either engine SHALL address one canonical durable run

`pipeline:loop` SHALL derive run identity solely from the goal-loop contract
compilation, so that equivalent inputs on the Claude and Codex hosts start or resume
the same run: one run id, one contract, one ledger, one lock. `--resume <run-id>` SHALL
address a run by id regardless of which engine created it. A run already held by
another process SHALL NOT be started concurrently; the facade SHALL surface the
existing lock holder rather than creating a parallel run.

#### Scenario: Cross-engine resume reuses the same run id

- **WHEN** a run is started under the `claude` adapter and later resumed via
  `$pipeline:loop --resume <run-id>` under the `codex` adapter
- **THEN** the same run id, contract, and ledger SHALL be used
- **AND** no new run record SHALL be created

#### Scenario: Equivalent selectors resolve to the same run

- **WHEN** `/pipeline:loop --milestone v2` and `$pipeline:loop --milestone v2` are
  invoked against the same repository state
- **THEN** both SHALL resolve to the same canonical contract and the same run id
- **AND** the second invocation SHALL resume rather than create a second run

#### Scenario: A locked run is not duplicated

- **WHEN** `pipeline:loop` targets a run whose lock is already held
- **THEN** it SHALL report the existing lock holder and exit without creating a second
  run or a second lock

---

### Requirement: The facade SHALL delegate all durable state to the installed goal-loop store

`pipeline:loop` SHALL NOT create or maintain any durable state of its own. All run
identity, contract compilation, locking, item transitions, decision records, events,
reconciliation, status, and audit output SHALL be produced by the installed goal-loop
state interface. The change SHALL NOT introduce a second ledger, a second run-id
namespace, a second lock, or a second run directory, and SHALL NOT copy or reimplement
the goal-loop state engine inside Agent Pipeline.

#### Scenario: No durable writes originate in the facade

- **WHEN** a loop run is exercised end to end against injected fakes
- **THEN** every durable write SHALL have been issued through the goal-loop state
  interface
- **AND** the facade SHALL have created no ledger, lock, run-id, or run-directory
  artifact of its own

#### Scenario: Pre-existing runs resume without migration

- **WHEN** `pipeline:loop --resume <run-id>` targets a run created before this change
  by a direct goal-loop invocation
- **THEN** the run SHALL resume from its existing contract and ledger
- **AND** no migration step, schema rewrite, or destructive modification of the
  existing run SHALL occur

---

### Requirement: Per-item execution SHALL use the engine-neutral `pipeline/loop-execution@1` contract

The interface between the loop orchestrator and per-item Pipeline execution SHALL be a
single documented, versioned contract identified as `pipeline/loop-execution@1`, and it
SHALL be identical for the Claude and Codex engines. Its request SHALL carry `item_id`,
`repo` (`name`, `base_branch`), `engine`, `worktree_policy`, `done_definition`, and
`run_id`. Its terminal outcome SHALL be exactly one of `ready_to_deploy`,
`blocked_needs_human`, `failed`, or `abandoned`, and it SHALL return an evidence
pointer (the PR number when one exists, plus the Pipeline run identifier). The contract
SHALL NOT expose any per-stage verb, so the orchestrator hands off a whole item and the
per-item advance loop never owns more than one issue.

#### Scenario: An item hand-off carries the full request

- **WHEN** the orchestrator dispatches a selected item for execution
- **THEN** the request SHALL include `item_id`, `repo.name`, `repo.base_branch`,
  `engine`, `worktree_policy`, `done_definition`, and `run_id`

#### Scenario: An unrecognized outcome is not silently retried

- **WHEN** per-item execution reports an outcome outside the defined terminal set
- **THEN** the orchestrator SHALL record the item as `failed`
- **AND** it SHALL NOT treat the response as success and SHALL NOT silently re-dispatch
  the item

#### Scenario: The interface exposes no per-stage verb

- **WHEN** the `pipeline/loop-execution@1` contract is inspected
- **THEN** it SHALL contain no operation that advances a single pipeline stage
- **AND** the contract SHALL be byte-identical in meaning for `engine: claude` and
  `engine: codex`

---

### Requirement: Selected items SHALL execute through the unmodified Pipeline state machine and evidence gates

Every item selected by a loop run SHALL be executed through the normal Agent Pipeline
state machine, review layer, and evidence gates. The facade SHALL NOT set, skip, or
reorder pipeline stage labels itself, SHALL NOT weaken or bypass review, eval, or
pre-merge gates, and SHALL treat an item as done only at `pipeline:ready-to-deploy`.
The facade SHALL NOT merge, and SHALL NOT weaken goal-loop's authority, merge, release,
dependency, or reconciliation gates.

#### Scenario: The facade does not move stage labels

- **WHEN** a loop run executes an item
- **THEN** all pipeline stage-label transitions SHALL originate from the Pipeline state
  machine
- **AND** the facade SHALL issue no stage-label write of its own

#### Scenario: Done means ready-to-deploy

- **WHEN** an item's execution reports `ready_to_deploy`
- **THEN** the ledger SHALL record it as done at `pipeline:ready-to-deploy`
- **AND** no merge SHALL be performed by the loop or the facade

#### Scenario: A blocked item does not advance the run past its gates

- **WHEN** an item's execution reports `blocked_needs_human`
- **THEN** the run SHALL record the block and honor goal-loop's existing stop and
  reconciliation semantics
- **AND** the item SHALL NOT be recorded as done

---

### Requirement: `pipeline:loop` SHALL require the host's built-in autonomous `/goal` mode

`pipeline:loop` SHALL require the active engine's built-in autonomous goal mode
(`/goal` on Claude Code, its Codex equivalent) for loop execution. When that mode is
unavailable, the command SHALL refuse to start, exit non-zero with remediation naming
the missing capability and the engine, and SHALL NOT fall back to a non-durable or
manually-supervised loop.

#### Scenario: Missing native goal mode aborts before mutation

- **WHEN** `pipeline:loop` is invoked on an engine whose built-in `/goal` mode is
  unavailable
- **THEN** it SHALL exit non-zero with remediation naming the missing capability
- **AND** it SHALL perform no lock acquisition, no ledger write, and no GitHub mutation

#### Scenario: No degraded fallback loop

- **WHEN** the native goal mode is unavailable
- **THEN** the command SHALL NOT start any substitute loop, single-shot execution, or
  partial run

---

### Requirement: The preflight SHALL run before any external mutation

`pipeline:loop` SHALL execute its checks in a fixed order: argument normalization
(pure), then the `loop:contract-coherence` compatibility check, then the native-goal
capability check, and only then contract compilation, lock acquisition, and run
start/resume. Every check before contract compilation SHALL be read-only. A failure in
any of them SHALL exit non-zero with actionable remediation and SHALL leave no external
side effect.

#### Scenario: Incompatible contract version aborts with zero writes

- **WHEN** the installed goal-loop's contract schema id is outside Pipeline's supported
  set and `pipeline:loop` is invoked
- **THEN** the command SHALL exit non-zero naming both the installed and the supported
  schema ids
- **AND** the injected write seams SHALL record zero calls — no lock, no ledger write,
  no GitHub mutation, no worktree or branch creation

#### Scenario: goal-loop absent aborts with an install remediation

- **WHEN** no installed goal-loop skill can be discovered
- **THEN** `pipeline:loop` SHALL exit non-zero with remediation instructing the user to
  install goal-loop
- **AND** it SHALL perform no external mutation

---

### Requirement: Legacy `goal-loop` invocations SHALL remain functional, with deprecation gated on proven evidence

The `/goal-loop` (Claude) and `$goal-loop` (Codex) invocations SHALL remain fully
functional aliases for the same durable behavior, targeting the same runs and the same
store. This change SHALL NOT emit a deprecation notice. A deprecation notice, and the
documented deprecation window it announces, SHALL be enabled only after a bounded live
run through `pipeline:loop` has been recorded as evidence that the facade works.

#### Scenario: Legacy alias still starts and resumes the same run

- **WHEN** `/goal-loop` or `$goal-loop` is invoked with a selector or `--resume`
  equivalent to a `pipeline:loop` invocation
- **THEN** it SHALL address the same run id, contract, and ledger
- **AND** its behavior SHALL be unchanged from before this change

#### Scenario: No deprecation notice before the facade is proven

- **WHEN** `/goal-loop` or `$goal-loop` is invoked as part of this change
- **THEN** no deprecation or compatibility-warning text SHALL be emitted

---

### Requirement: Repository consolidation SHALL remain out of scope pending a recorded live run

This change SHALL NOT merge, archive, or delete the goal-loop repository, SHALL NOT
absorb its state engine into Agent Pipeline, and SHALL NOT alter the goal-loop release
or version boundary. Any consolidation SHALL be a separately approved change, taken
only after a bounded live run through `pipeline:loop` is recorded and the re-decision
criteria in this change's design record are evaluated.

#### Scenario: No consolidation artifacts in this change

- **WHEN** this change's diff is inspected
- **THEN** it SHALL contain no goal-loop repository archive/deletion, no copied state
  engine, and no change to goal-loop's release or versioning boundary

#### Scenario: Consolidation is evidence-gated

- **WHEN** a repository-consolidation decision is proposed
- **THEN** it SHALL cite a recorded bounded live run through `pipeline:loop`
- **AND** it SHALL be evaluated against the documented re-decision criteria

