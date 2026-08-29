## REMOVED Requirements

### Requirement: `pipeline:loop` SHALL be the canonical durable multi-item run command on both hosts

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

### Requirement: `pipeline:loop` SHALL require the host's built-in autonomous `/goal` mode

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

### Requirement: Host packaging for `pipeline:loop` SHALL NOT claim multi-item runs complete in seconds without progress follow

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

### Requirement: Host packaging for `pipeline:loop` SHALL describe durable runs as long-running and event-followed

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

### Requirement: `pipeline:loop --audit` SHALL print the per-item stage-progress table

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

### Requirement: `pipeline:loop` SHALL accept a documented read-only stage-progress follow path

**Reason:** Issue #1048 retires generated per-verb host command files and makes `pipeline loop` the canonical CLI operation exposed through host SKILL guidance.

**Migration:** Invoke `pipeline loop` through the host SKILL and preserve the existing durable-run, preflight, audit, and follow behavior without a generated `pipeline:loop` command file.

## ADDED Requirements

### Requirement: `pipeline loop` SHALL be the canonical durable multi-item run command on every host

The CLI SHALL expose a `loop` operation as `pipeline loop`; host SKILLs SHALL invoke
that CLI rather than depend on generated `/pipeline:loop` or `$pipeline:loop` files.
Claude and Codex SHALL accept an
identical argument contract with exactly these selector and mode arguments:
`--milestone <name>`, `--label <label>`, `--range <spec>`, `--roadmap-slice <slice>`,
an explicit issue list (one or more issue numbers), `--resume <run-id>`, and `--audit`.
Selector arguments SHALL be mutually exclusive with `--resume`, and `--audit` SHALL be
a read-only mode that performs no mutation.

#### Scenario: Host SKILLs expose the same CLI loop contract

- **WHEN** the CLI registry and generated host SKILL command tables are enumerated
- **THEN** each host SHALL describe exactly one `pipeline loop` operation
- **AND** the host descriptions SHALL declare the same argument contract
- **AND** no per-verb command file SHALL be required

#### Scenario: Each selector form parses to a normalized selector

- **WHEN** `pipeline loop` is invoked with `--milestone v2`, `--label backlog`,
  `--range 400-420`, `--roadmap-slice next`, or an explicit list `418 419 420`
- **THEN** argument normalization SHALL produce a selector whose type is respectively
  `milestone`, `label`, `work-list`, `roadmap-slice`, and `work-list`, with the
  corresponding value
- **AND** an invocation combining a selector with `--resume` SHALL be rejected with a
  non-zero exit and a message naming the conflict

#### Scenario: Audit mode is read-only

- **WHEN** `pipeline loop --audit` is invoked for an existing run
- **THEN** it SHALL print that run's status/report from the durable store
- **AND** it SHALL perform no write to the ledger, no lock acquisition, and no GitHub
  mutation

### Requirement: `pipeline loop` SHALL require the host's built-in autonomous `/goal` mode

`pipeline loop` SHALL require the active engine's built-in autonomous goal mode
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
- **AND** `pipeline loop` SHALL proceed past preflight to contract compilation

#### Scenario: A goal-mode marker in `--help` still passes

- **WHEN** the engine's `--help` output advertises a built-in goal mode
- **THEN** the native-goal check SHALL return a passing result regardless of the version floor

#### Scenario: Engine below the documented floor fails closed

- **WHEN** the engine's `--version` reports a version below the documented per-engine floor
  and no operator attestation is configured
- **THEN** the native-goal check SHALL fail
- **AND** `pipeline loop` SHALL exit non-zero having performed no lock acquisition, no ledger
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

### Requirement: Host SKILL guidance for `pipeline loop` SHALL NOT claim multi-item runs complete in seconds without progress follow

Host SKILL and CLI guidance for `pipeline loop` SHALL NOT claim that a multi-item durable loop drive
“completes in seconds” or that “No Monitor” / no progress follow is needed for that drive.
The claim applies to every host SKILL generated from the shared operation catalog. Guidance SHALL
state that a successful drive emits an early machine-readable handoff
containing `run_id` and the absolute `events` path so an operator or harness can follow
structured progress for the wall-clock duration of the run. Short-lived modes that remain
short-lived (`--audit` when it only prints a report) MAY still be described as fast,
provided they are not conflated with the multi-item drive path. No generated per-verb command
file SHALL be required to carry this guidance.

#### Scenario: Host SKILL no longer denies progress follow for multi-item drive

- **WHEN** the generated host SKILL guidance for `pipeline loop` is inspected
- **THEN** it SHALL NOT claim that multi-item durable drive completes in seconds with no
  Monitor or progress follow needed
- **AND** it SHALL mention the early handoff's `run_id` and events path as the way to
  follow progress

#### Scenario: Both hosts stay aligned

- **WHEN** the Claude and Codex SKILL guidance for `pipeline loop` are compared after the change
- **THEN** neither host SHALL reintroduce the false “completes in seconds / No Monitor
  needed” claim for multi-item durable drive
- **AND** both SHALL describe the same early-handoff progress-follow contract

### Requirement: Host SKILL guidance for `pipeline loop` SHALL describe durable runs as long-running and event-followed

The facade’s CLI and host SKILL guidance for Claude and Codex SHALL describe multi-item durable drive and resume as long-running work that harnesses follow via the loop event stream. The guidance SHALL NOT instruct harnesses to treat drive/resume as a seconds-only synchronous command that needs no Monitor. This requirement SHALL NOT depend on a generated `pipeline:loop` command body. It is packaging and operator-orchestration only; it does not change preflight order, contract compilation, per-item execution through `pipeline/loop-execution@1`, or the facade’s refusal to merge.

#### Scenario: Drive packaging points at event following

- **WHEN** a harness reads the host SKILL guidance for a `pipeline loop` multi-item drive
  or resume
- **THEN** the guidance SHALL NOT claim the run completes in seconds with no Monitor
- **AND** the guidance SHALL instruct long-running orchestration or point to the shared
  loop event-following protocol

#### Scenario: Facade execution rules remain unchanged

- **WHEN** this packaging requirement is applied
- **THEN** selected items SHALL still execute through the unmodified Pipeline
  state machine and evidence gates
- **AND** the facade SHALL still perform no merge

### Requirement: `pipeline loop --audit` SHALL print the per-item stage-progress table

The `pipeline loop` facade's `--audit` mode SHALL print a human-readable per-item stage-progress table (or equivalent structured section) for the resolved durable loop run. Each row SHALL include the item id, a current-stage presentation (or clear queued/pending presentation), and the advance run-id when known so an operator can invoke `pipeline logs <advance-run-id> --follow`. Audit SHALL remain read-only and SHALL NOT start or resume a mutating supervisor cycle solely because the stage table is rendered.

#### Scenario: Audit CLI output names stage and advance run id

- **WHEN** `pipeline loop --audit` (with `--resume <run-id>` when required to select the run) succeeds for a run where item `607` is `implementing` with advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** stdout SHALL include the item identifier, the stage presentation `implementing`, and the advance run id `607-2026-07-27T19-31-29-328Z`

#### Scenario: Audit does not start the run

- **WHEN** `pipeline loop --audit` prints the stage table
- **THEN** it SHALL perform no ledger mutation, no lock acquisition for driving the run, and no GitHub mutation

### Requirement: `pipeline loop` SHALL accept a documented read-only stage-progress follow path

The `pipeline loop` argument contract SHALL accept a documented observation combination that follows whole-run stage-progress events as clean one-line output. At least one of the following SHALL be supported and documented: `--audit --follow`, or an observation-only follow mode that targets an existing run id without requiring the operator to manually `tail` files. The follow path SHALL stream stage transitions (item id, stage, optional round, advance run-id when known) and SHALL NOT primarily re-emit interleaved per-item harness terminal prose. The follow path SHALL be classified read-only for lock/reservation purposes.

#### Scenario: Documented follow path is accepted by argument normalization

- **WHEN** `pipeline loop` is invoked with the documented stage-progress follow combination for an existing run
- **THEN** argument normalization SHALL accept the combination rather than rejecting `--follow` as an unknown flag
- **AND** the invocation SHALL be classified as read-only observation (no run-liveness reservation)

#### Scenario: Follow output is stage progress, not harness stdout

- **WHEN** the documented follow path streams while a stage transition is recorded for item `607`
- **THEN** the emitted line SHALL include item `607` and the new stage
- **AND** SHALL NOT be a passthrough of the child advance harness's interleaved terminal prose

#### Scenario: Mutating resume remains unambiguous

- **WHEN** `pipeline loop --resume <run-id>` is invoked without the observation follow combination
- **THEN** existing resume/drive semantics SHALL remain unchanged
- **AND** the addition of the follow observation path SHALL NOT silently disable or dual-purpose a mutating resume without documentation

## MODIFIED Requirements

### Requirement: Equivalent invocations on either engine SHALL address one canonical durable run

`pipeline loop` SHALL derive run identity solely from the in-repo durable loop engine's
contract compilation, so that equivalent inputs on the Claude and Codex hosts start or resume
the same run: one run id, one contract, one ledger, one lock. `--resume <run-id>` SHALL
address a run by id regardless of which engine created it, including a run created before
this change by the external goal-loop skill. A run already held by another process SHALL NOT
be started concurrently; the facade SHALL surface the existing lock holder rather than
creating a parallel run.

#### Scenario: Cross-engine resume reuses the same run id

- **WHEN** a run is started under the `claude` adapter and later resumed via
  `pipeline loop --resume <run-id>` under the `codex` adapter
- **THEN** the same run id, contract, and ledger SHALL be used
- **AND** no new run record SHALL be created

#### Scenario: Equivalent selectors resolve to the same run

- **WHEN** `pipeline loop --milestone v2` is invoked through Claude and Codex host SKILLs
  against the same repository state
- **THEN** both SHALL resolve to the same canonical contract and the same run id
- **AND** the second invocation SHALL resume rather than create a second run

#### Scenario: A locked run is not duplicated

- **WHEN** `pipeline loop` targets a run whose lock is already held
- **THEN** it SHALL report the existing lock holder and exit without creating a second
  run or a second lock

### Requirement: The preflight SHALL run before any external mutation

`pipeline loop` SHALL execute its checks in a fixed order: argument normalization
(pure), then the durable loop store's schema-compatibility check, then the native-goal
capability check, and only then contract compilation, lock acquisition, and run
start/resume. Every check before contract compilation SHALL be read-only. A failure in
any of them SHALL exit non-zero with actionable remediation and SHALL leave no external
side effect. The preflight SHALL NOT check for, discover, or require an externally
installed goal-loop skill, and its absence SHALL NOT fail any check.

#### Scenario: An unsupported store schema aborts with zero writes

- **WHEN** a targeted run records a contract or ledger schema id outside the durable loop
  store's supported set and `pipeline loop` is invoked
- **THEN** the command SHALL exit non-zero naming both the recorded and the supported
  schema ids
- **AND** the injected write seams SHALL record zero calls — no lock, no ledger write,
  no GitHub mutation, no worktree or branch creation

#### Scenario: A missing goal-loop install is not a failure

- **WHEN** `pipeline loop` is invoked on a host where no goal-loop skill is installed at any
  root
- **THEN** the preflight SHALL pass its store-compatibility check
- **AND** it SHALL proceed to the native-goal capability check and contract compilation

### Requirement: Legacy `goal-loop` invocations SHALL remain functional, with deprecation gated on proven evidence

The `/goal-loop` (Claude) and `$goal-loop` (Codex) invocations SHALL, where they remain
installed on a host, continue to address the same runs a `pipeline loop` invocation would,
via the import path defined for pre-existing runs. Agent Pipeline SHALL NOT require, ship, or
depend on those invocations, and SHALL NOT execute them. A run that Pipeline has imported
SHALL be marked so a legacy invocation cannot drive a divergent second copy of it.

#### Scenario: A pre-existing legacy run is addressable by run id

- **WHEN** `pipeline loop --resume <run-id>` names a run created by a legacy `/goal-loop`
  invocation
- **THEN** it SHALL address that run's contract, ledger, and history
- **AND** it SHALL not create a second run for that id

#### Scenario: Pipeline never executes the legacy skill

- **WHEN** any `pipeline loop` path is exercised through the injected seams
- **THEN** no subprocess invocation of a goal-loop skill or its state CLI SHALL be recorded

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
- **THEN** the native-goal check SHALL fail and `pipeline loop` SHALL refuse to start

#### Scenario: Absent attestation preserves automatic detection

- **WHEN** the attestation key is absent from `.github/pipeline.yml`
- **THEN** the probe SHALL fall through to the marker and version-floor signals
- **AND** the configuration SHALL remain valid without the key

### Requirement: The facade SHALL delegate all durable state to the in-repo durable loop engine

`pipeline loop` SHALL NOT create or maintain any durable state of its own. All run identity,
contract compilation, locking, item transitions, decision records, events, reconciliation,
status, and audit output SHALL be produced by the in-repo durable loop engine. The facade
SHALL NOT introduce a second ledger, a second run-id namespace, a second lock, or a second
run directory, and SHALL NOT reimplement any part of the engine inside the command layer.

#### Scenario: No durable writes originate in the facade

- **WHEN** a loop run is exercised end to end against injected fakes
- **THEN** every durable write SHALL have been issued through the durable loop engine's
  interface
- **AND** the facade SHALL have created no ledger, lock, run-id, or run-directory artifact of
  its own

#### Scenario: Exactly one durable store is authoritative

- **WHEN** a run is started, resumed, and audited
- **THEN** all three SHALL read and write the same single run directory under the Pipeline
  state home
- **AND** no second durable store SHALL be consulted except the documented read-only legacy
  import path

### Requirement: `pipeline loop` SHALL surface an early run handoff on the facade drive path

The `pipeline loop` facade SHALL surface the early machine-readable run
handoff defined by capability `loop-early-run-handoff` on the drive path after a successful
preflight and a successful create-or-resume plus exclusive lock of the durable run, and
before the first item dispatch of that process. The facade SHALL NOT delay that handoff
until the supervisor terminal condition. The facade SHALL continue to emit the existing
terminal drive summary when the supervisor returns, and SHALL continue to refuse preflight
failures with non-zero exit, remediation, and zero external mutation. `--audit` SHALL remain
read-only and SHALL NOT emit the drive handoff.

#### Scenario: Facade drive path exposes handoff before dispatch

- **WHEN** `pipeline loop` successfully starts or resumes a durable multi-item run through
  any host SKILL
- **THEN** the facade's CLI process SHALL emit the early `loop_run_handoff` JSON on stdout
  before the first per-item dispatch
- **AND** the same process SHALL still emit the terminal drive summary when the run reaches
  a terminal condition

#### Scenario: Facade failure path still mutates nothing and emits no handoff

- **WHEN** the facade preflight fails
- **THEN** the command SHALL exit non-zero with remediation
- **AND** it SHALL emit no `loop_run_handoff`
- **AND** it SHALL leave no lock, ledger write, or GitHub mutation attributable to a drive

### Requirement: The explicit issue-list selector SHALL be invocable end-to-end from the CLI

The top-level CLI positional guard SHALL allow `pipeline loop` to accept one or more issue-number positionals
after the `loop` keyword, so that an explicit issue list reaches loop argument
normalization and becomes a `work-list` selector. No CLI-layer guard SHALL reject a
multi-issue list with an "unexpected argument(s)" error before preflight runs. The
operator SHALL NOT be forced to invent a temporary label or range solely because the
documented issue-list form is unreachable.

The number of issue positionals accepted at the dispatcher SHALL be at least large enough
to cover any work-list that `--range` may expand (the existing `MAX_RANGE_SPAN` ceiling).
Token shape validation (digits only), mutual exclusion with other selectors and with
`--resume`, and empty-selector rules SHALL remain the responsibility of loop argument
normalization — not of the top-level arity guard.

#### Scenario: Multi-issue positionals are not rejected as unexpected arguments

- **WHEN** the operator runs `pipeline loop 649 551 541 334` (with no other selector flags)
- **THEN** the CLI SHALL NOT exit with code 2 for unexpected positional arguments naming
  `551`, `541`, or `334`
- **AND** the loop command handler SHALL receive the positional issues
  `["649", "551", "541", "334"]`
- **AND** argument normalization SHALL produce a selector of type `work-list` with that
  value

#### Scenario: A single issue positional is a one-element work-list

- **WHEN** the operator runs `pipeline loop 649` with no selector flags
- **THEN** argument normalization SHALL produce a selector of type `work-list` with value
  `["649"]`
- **AND** the invocation SHALL NOT be treated as a plain advance of issue 649

#### Scenario: Non-numeric positionals still fail in loop normalization

- **WHEN** the operator runs `pipeline loop 649 not-an-issue`
- **THEN** the command SHALL exit non-zero with an error that names the invalid token as
  not an issue number
- **AND** the failure SHALL come from loop argument normalization (or an equivalent
  loop-owned validation path), not from a generic "unexpected argument(s)" rejection of a
  valid multi-issue list shape

#### Scenario: Issue-list mutual exclusion with other selectors is unchanged

- **WHEN** the operator combines positional issues with another selector flag
  (`--milestone`, `--label`, `--range`, or `--roadmap-slice`) or with `--resume`
- **THEN** argument normalization SHALL reject the combination with a non-zero exit
- **AND** the error SHALL name the conflict using the existing multi-selector / resume
  rules

#### Scenario: Other commands keep their positional caps

- **WHEN** a non-`loop` command that is subject to the shared extra-positionals guard is
  invoked with more positionals than its existing cap
- **THEN** the CLI SHALL still reject the extras with exit code 2
- **AND** only the `loop` command gains multi-issue positional capacity under this change
