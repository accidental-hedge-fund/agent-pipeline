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

The capability SHALL be determined by a read-only probe whose signals actually carry
slash-command availability. The probe SHALL resolve, in order: (1) an explicit operator
attestation in pipeline configuration, which is authoritative in both directions; (2) a
positive goal-mode marker in the engine CLI's `--help` output, which SHALL be an accepting
signal only; (3) a documented per-engine minimum version floor compared against the engine's
own `--version` output. Absence of a goal-mode string in `--help` SHALL NOT be treated as
evidence that the capability is missing. The probe SHALL NOT start an engine session, and
SHALL NOT read undocumented engine-internal files.

#### Scenario: Capable host whose `--help` omits the slash command passes

- **WHEN** the active engine is `claude`, its `--version` reports a version at or above the
  documented floor, and its `--help` output contains no `goal` marker
- **THEN** the native-goal check SHALL return a passing result
- **AND** `pipeline:loop` SHALL proceed past preflight to contract compilation

#### Scenario: A goal-mode marker in `--help` still passes

- **WHEN** the engine's `--help` output advertises a built-in goal mode
- **THEN** the native-goal check SHALL return a passing result regardless of the version floor

#### Scenario: Engine below the documented floor fails closed

- **WHEN** the engine's `--version` reports a version below the documented per-engine floor
  and no operator attestation is configured
- **THEN** the native-goal check SHALL fail
- **AND** `pipeline:loop` SHALL exit non-zero having performed no lock acquisition, no ledger
  write, and no GitHub mutation

#### Scenario: Engine with no known native goal mode fails closed

- **WHEN** the active engine has no documented version floor because no native goal mode is
  known for it, and no operator attestation is configured
- **THEN** the native-goal check SHALL fail rather than pass by default

#### Scenario: Unreadable or unparseable version fails closed

- **WHEN** the engine's `--version` invocation fails, returns empty output, or returns a
  string from which no `major.minor.patch` version can be extracted, and no operator
  attestation is configured
- **THEN** the native-goal check SHALL fail rather than assume the capability is present

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

### Requirement: The native-goal probe SHALL honor an explicit operator attestation

Pipeline configuration SHALL provide an optional operator attestation key for the engine's
native goal-mode capability, with an automatic-detection default plus explicit
`available` and `unavailable` values. The attestation SHALL take precedence over every
inferred signal in both directions, and SHALL be read from the repository's pipeline
configuration file so the assertion is reviewable and auditable. Omitting the key SHALL leave
behavior unchanged from automatic detection, so existing configurations remain valid.

#### Scenario: Attestation of `available` overrides failed detection

- **WHEN** the attestation key is set to `available` and automatic detection would otherwise
  fail (version unreadable, below floor, or no floor known for the engine)
- **THEN** the native-goal check SHALL pass

#### Scenario: Attestation of `unavailable` overrides successful detection

- **WHEN** the attestation key is set to `unavailable` and the engine's version is at or above
  the documented floor
- **THEN** the native-goal check SHALL fail and `pipeline:loop` SHALL refuse to start

#### Scenario: Absent attestation preserves automatic detection

- **WHEN** the attestation key is absent from `.github/pipeline.yml`
- **THEN** the probe SHALL fall through to the marker and version-floor signals
- **AND** the configuration SHALL remain valid without the key

### Requirement: A native-goal failure SHALL report accurate, actionable remediation

When the native-goal check fails, the remediation text SHALL name the active engine, the
detected engine version string (or state that it could not be read), the required version
floor (or state that no native goal mode is known for that engine), and the operator
attestation key together with its accepted values. The remediation SHALL NOT instruct the
operator to update an engine that already satisfies the documented floor.

#### Scenario: Below-floor failure names version, floor, and attestation key

- **WHEN** the native-goal check fails because the detected version is below the floor
- **THEN** the remediation SHALL include the detected version, the required floor, and the
  attestation key with its accepted values

#### Scenario: Unknown-capability failure does not claim an update will help

- **WHEN** the native-goal check fails for an engine with no documented floor
- **THEN** the remediation SHALL state that no native goal mode is known for that engine and
  point at the attestation key
- **AND** it SHALL NOT assert that updating the engine binary resolves the failure

### Requirement: The per-engine version floor SHALL carry recorded evidence

Each per-engine native-goal version floor SHALL be defined in a single place alongside
recorded evidence: the engine, the version verified, and the date the verification was made.
An engine for which no native goal mode has been verified SHALL be represented explicitly as
having no floor rather than being given a guessed value.

#### Scenario: Floor definition states its evidence

- **WHEN** the version-floor table is inspected
- **THEN** each engine entry SHALL state either a floor with its verifying version and date,
  or an explicit "no known native goal mode" value

#### Scenario: Regression coverage exercises detection through the injected seam

- **WHEN** the native-goal probe's unit tests run
- **THEN** they SHALL drive the probe entirely through the `DoctorDeps` seam with no real
  subprocess, network, or git access
- **AND** they SHALL cover a capable host whose `--help` omits the marker, a below-floor host,
  an engine with no known floor, an unparseable version, and both attestation directions

