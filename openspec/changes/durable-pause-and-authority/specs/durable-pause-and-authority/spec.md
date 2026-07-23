## ADDED Requirements

### Requirement: Paused and waiting SHALL be durable, non-failure holds distinct from blocked

The engine SHALL treat `paused` and `waiting` as durable, non-terminal item states that represent
a deliberate hold rather than a failure. Neither state SHALL carry a `DurableBlockerClass` theme,
SHALL charge any recovery budget, or SHALL increment the consecutive-blocked count. Both states,
together with any hold metadata, SHALL be persisted in the durable ledger so a resuming engine
reads the same hold after a process restart. An item SHALL leave `paused` or `waiting` only by an
audited resume back to `in_progress` or by a transition to `abandoned`; the engine SHALL refuse
any other outgoing transition from these states as a validation failure naming both states.

#### Scenario: Entering waiting charges no budget and counts no block

- **WHEN** an in-progress item transitions to `waiting`
- **THEN** no recovery budget SHALL be decremented
- **AND** the consecutive-blocked count SHALL be unchanged
- **AND** the item SHALL carry no `DurableBlockerClass` theme

#### Scenario: A paused hold survives restart

- **WHEN** a new engine process resumes a run whose item is `paused`
- **THEN** it SHALL read the item as `paused` from the durable store
- **AND** any outstanding human-input request for that item SHALL be readable unchanged

#### Scenario: An illegal transition out of a hold is refused

- **WHEN** a transition from `waiting` to any state other than `in_progress` or `abandoned` is
  attempted
- **THEN** it SHALL be refused as a validation failure naming both states
- **AND** the item's state SHALL be unchanged

### Requirement: Every waiting transition SHALL record a precise human-input request

The engine SHALL require, on every transition into `waiting`, a structured human-input request
naming the item id, a request kind drawn from the closed set `decision`, `answer`, or
`authority-grant`, the prompt describing what is needed, an optional closed set of permitted
responses, and the requesting engine and time. The request SHALL be persisted with the item in the
durable ledger and assigned a request id unique within the run. A `waiting` transition that
supplies no request, an unknown request kind, or a request whose permitted-response set is present
but empty SHALL be refused as a validation failure leaving durable state unchanged.

#### Scenario: A waiting transition without a request is refused

- **WHEN** a transition to `waiting` supplies no human-input request
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: A request with a closed response set records its options

- **WHEN** a `waiting` transition supplies a request of kind `decision` with a non-empty permitted
  response set
- **THEN** the request SHALL be persisted with the item, carrying its request id, kind, prompt,
  permitted responses, requesting engine, and time

#### Scenario: An unknown request kind is refused

- **WHEN** a `waiting` transition supplies a request whose kind is not one of `decision`, `answer`,
  or `authority-grant`
- **THEN** it SHALL be refused as a validation failure naming the offending kind

### Requirement: Resume SHALL be audited and fail closed against the outstanding request

The engine SHALL resume a `paused` or `waiting` item to `in_progress` only through an audited
resume that appends an attributed decision to the run's decision log recording the resuming engine,
a human actor reference, the supplied response, and the time. The resume SHALL be refused, leaving
durable state unchanged, when there is no active hold on the item, when the supplied response names
a different request than the item's outstanding one, or when the outstanding request defines a
closed permitted-response set and the response is not a member of it. An audited resume SHALL NOT
weaken the engine's existing evidence requirements for entering `in_progress`: the pipeline-mandate
and native-goal-mandate checks SHALL still apply, so a resume with a satisfying response but absent
or stale mandate evidence SHALL still be refused under those mandate failure classes.

#### Scenario: A satisfying, evidenced resume advances the item

- **WHEN** a `waiting` item is resumed with a response that names its outstanding request and, when
  a closed set is defined, selects a permitted option, and valid pipeline and native-goal evidence
  is supplied
- **THEN** the item SHALL transition `waiting → in_progress`
- **AND** an attributed resume decision SHALL be appended to the decision log
- **AND** the outstanding request SHALL be cleared

#### Scenario: A response outside the permitted set is refused

- **WHEN** a resume supplies a response outside the outstanding request's closed permitted set
- **THEN** it SHALL be refused as a validation failure
- **AND** the item SHALL remain in its hold with its request intact
- **AND** no resume decision SHALL be appended

#### Scenario: Resume still honors the entry mandates

- **WHEN** a resume supplies a satisfying response but no valid native-goal evidence
- **THEN** it SHALL be refused with a native-goal-mandate failure
- **AND** the item SHALL remain in its hold

### Requirement: Authority amendments SHALL be scoped, audited, and fail closed

The engine SHALL permit an authority grant to be amended after compile time only through an
audited amendment that appends an attributed decision to the run's decision log naming exactly one
authority gate (`push_pr`, `merge`, `release`, or `deploy`), an optional single item id as its
scope, a human actor reference, a reason, and the time. The amendment SHALL be persisted durably
and honored on later gated transitions, but SHALL authorize a gated transition only when both the
gate and the scope match: an amendment scoped to one item SHALL NOT authorize the gate on any other
item, and an amendment for one gate SHALL NOT authorize any other gate. An amendment that names no
gate, an unknown gate, or more than one gate SHALL be refused as a validation failure. An authority
amendment SHALL NOT bypass the engine's directly-verified-evidence requirement for a gated
transition — a transition covered by an amendment but supplying no evidence SHALL still be refused.

#### Scenario: A scoped amendment authorizes exactly its gate and item

- **WHEN** an audited amendment grants `merge` scoped to item `A`, and item `A` later attempts the
  merge-gated transition with directly verified evidence
- **THEN** the transition SHALL be authorized
- **AND** the same merge-gated transition attempted by item `B` SHALL be refused with an
  authority-class failure

#### Scenario: An amendment does not widen to other gates

- **WHEN** an audited amendment grants `merge` scoped to item `A`, and item `A` attempts a
  `release`-gated transition
- **THEN** the `release` transition SHALL be refused with an authority-class failure

#### Scenario: An amendment does not bypass the evidence mandate

- **WHEN** an audited amendment grants a gate for an item and that item attempts the gated
  transition with no evidence
- **THEN** it SHALL be refused as a validation failure demanding directly verified facts

#### Scenario: A malformed amendment is refused

- **WHEN** an amendment names no gate, an unknown gate, or more than one gate
- **THEN** it SHALL be refused as a validation failure
- **AND** no amendment SHALL be recorded and durable state SHALL be unchanged

### Requirement: Cross-engine handoff SHALL be audited and require re-attestation

The engine SHALL permit a `paused` or `waiting` run to be handed from the current engine to the
other engine only through an audited handoff that appends an attributed decision to the run's
decision log naming the from-engine, the to-engine, a reason, and the time, and that releases the
current lock without transferring its token. A handoff SHALL be refused while any item is
`in_progress`, so no run is handed off mid-active-work. After a handoff the receiving engine SHALL
acquire a fresh lock and SHALL re-attest its native goal mode under the existing native-goal
mandate before it may resume any item; the handoff itself SHALL NOT satisfy that mandate.

#### Scenario: A handoff records attribution and drops the lock

- **WHEN** a `paused` run is handed from `claude` to `codex`
- **THEN** an attributed handoff decision SHALL be appended naming from-engine, to-engine, reason,
  and time
- **AND** the current lock SHALL be released without its token being transferred

#### Scenario: A handoff during active work is refused

- **WHEN** a handoff is attempted while an item is `in_progress`
- **THEN** it SHALL be refused with a conflict-class failure
- **AND** the lock and durable state SHALL be unchanged

#### Scenario: The receiving engine re-attests before resuming

- **WHEN** the receiving engine acquires a fresh lock after a handoff and attempts to resume an
  item without valid native-goal evidence
- **THEN** the resume SHALL be refused with a native-goal-mandate failure

### Requirement: Pause, request, amendment, resume, and handoff refusals SHALL reuse the existing failure taxonomy

The engine SHALL classify every refusal on these surfaces into exactly one of the engine's existing
failure classes — validation, lock, authority, stop, conflict, pipeline mandate, or native-goal
mandate — and SHALL NOT introduce an untyped refusal. Every such refusal SHALL leave the ledger,
event log, decision log, and lock byte-identical to their pre-attempt content.

#### Scenario: Each refusal carries an existing class

- **WHEN** a malformed request, an out-of-scope amendment, a mismatched resume response, and a
  handoff during active work are each attempted
- **THEN** each SHALL be refused with, respectively, a validation, authority, validation, and
  conflict failure

#### Scenario: A refused hold operation is side-effect free

- **WHEN** any refusal path on these surfaces is exercised through the injected seams
- **THEN** the ledger, event log, decision log, and lock SHALL be unchanged from their pre-attempt
  content
