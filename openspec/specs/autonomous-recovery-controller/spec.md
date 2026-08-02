# autonomous-recovery-controller Specification

## Purpose
TBD - created by archiving change autonomous-recovery-controller. Update Purpose after archive.
## Requirements
### Requirement: Stage diagnostics SHALL be canonical, closed, and provider-neutral

Every blocked model-executed stage SHALL emit a `pipeline/stage-diagnostic@1` record with a closed
`reason_code`, stable `evidence_key`, and bounded structured detail containing a recognized
`blocker_kind`, reason, and optional stage/pre-merge class. The closed reason-code set SHALL be
exactly `workflow-state`, `implementation-ci`, `workflow-engine-defect`, `environment-auth`, `worktree-capacity`,
`human-decision-required`, `openspec-archive-apply-conflict`, and
`openspec-generated-delta-invalid`. One exhaustive projection SHALL derive the durable blocker
class and recovery disposition from that record. The projection SHALL NOT inspect a
harness/provider name, issue label, or free-form diagnostic prose.

#### Scenario: Equivalent failures project identically across harnesses

- **WHEN** two configured harness adapters emit canonical `workflow-engine-defect` diagnostics
  with the same normalized blocker detail
- **THEN** the controller SHALL derive the same blocker class, recovery disposition, and permitted
  recipe set for both
- **AND** no provider-specific recovery branch SHALL run

#### Scenario: Unknown diagnostic versions are engine defects

- **WHEN** the controller receives an unsupported diagnostic version or an out-of-enum reason code
- **THEN** it SHALL classify the response as a protocol `workflow-engine-defect`
- **AND** it SHALL NOT infer authority from the issue labels or diagnostic prose

### Requirement: Human holds SHALL require positive current product or authority evidence

The controller SHALL create a human hold only when fresh dispatch evidence carries a canonical
`human-decision-required` diagnostic whose structured blocker kind is also
`human-decision-required` and whose non-empty authority evidence names a `product-decision` or
`authority` finding key/fingerprint at the freshly observed candidate SHA. A `pipeline:blocked`
label, a `blocked_needs_human` outcome without that diagnostic, stale or missing authority
evidence, an exhausted mechanical budget, merge conflict, external dependency, or OpenSpec
validation failure SHALL NOT satisfy this predicate. Engine-owned exhaustion SHALL terminate as a
typed system failure without emitting `human_intervention`.

#### Scenario: Attested product decision creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with the
  matching structured blocker kind, sanctioned category, finding identity, and current reviewed SHA
- **THEN** the controller SHALL create a resumable human hold for that item
- **AND** the hold SHALL retain the diagnostic evidence and reconciled candidate identity

#### Scenario: Mechanical exhaustion is not human authority

- **WHEN** an OpenSpec or worktree recovery exhausts its configured budget
- **THEN** the controller SHALL record a typed engine-owned terminal failure
- **AND** it SHALL NOT create a human hold or emit `human_intervention`

#### Scenario: Candidate movement invalidates authority

- **WHEN** fresh reconciliation observes a HEAD different from the candidate SHA retained by a
  human-authority hold
- **THEN** the controller SHALL invalidate the hold and re-admit the item in the same cycle
- **AND** a remaining `pipeline:blocked` label SHALL NOT preserve the stale authority

### Requirement: Recovery attempts SHALL be claimed and charged before side effects

Before executing a recovery action, the controller SHALL durably create one attempt keyed by item,
authoritative candidate identity, evidence fingerprint, and action with `outcome: "started"`.
Starting the attempt SHALL consume one unit of the class budget before the external side effect.
The record SHALL retain the attempt id, sequence, item, class, candidate identity, action, evidence
fingerprint, budget remaining, durable `not_before` eligibility time, completion time, outcome, and
error supported by the recovery ledger. Success, failure, timeout, and process death after
`started` SHALL consume that unit.
Preflight before `started` SHALL NOT consume an implementer repair unit.

#### Scenario: Failed action consumes budget

- **WHEN** a claimed recovery action invokes its executor and that executor fails
- **THEN** the attempt SHALL be persisted as failed
- **AND** the remaining budget SHALL reflect the charged attempt

#### Scenario: Crash after claim does not grant a free replay

- **WHEN** the process dies after persisting `outcome: "started"` but before its result
- **THEN** a resumed controller SHALL reconcile the action's postcondition against live truth
- **AND** any replay SHALL remain within the already-charged attempt identity rather than creating
  an uncharged attempt

#### Scenario: Backoff does not starve independent work

- **WHEN** a claimed recovery action has a future `not_before` eligibility time
- **THEN** the controller SHALL defer that action without sleeping in the item execution path
- **AND** it SHALL schedule any dependency-independent sibling before the idle driver waits

#### Scenario: Rematerialization preflight does not consume implementer repair

- **WHEN** worktree rematerialization or candidate-currency preflight fails before an implementer
  repair claim is created
- **THEN** no implementer repair unit SHALL be consumed
- **AND** the preflight failure SHALL retain its own typed diagnostic and recovery disposition

### Requirement: Recovery SHALL execute before terminal classification

For every engine-owned recoverable diagnostic, the production controller SHALL reconcile current
state, select and start a permitted recipe, execute that recipe, reconcile the result, and only
then decide whether to resume, retry, or terminate. A run-fatal or terminal engine outcome
SHALL NOT be persisted while a safe permitted recipe has unconsumed budget. A genuine current human
authority decision MAY bypass automated recovery and enter a hold immediately. A blocked item SHALL
NOT prevent dependency-independent siblings from continuing when the run contract permits them.
For workflow-state, implementation-CI, and workflow-engine failures, policy SHALL attempt the
corresponding deterministic redispatch/re-entry recipe before `repair_pipeline_item`. Repeated
current evidence SHALL advance to the next configured recipe without repeating the exhausted
deterministic action indefinitely.

#### Scenario: Recoverable dispatch failure is handled before stop

- **WHEN** a whole-item dispatch returns `blocked_recoverable` with a current canonical diagnostic
  and retry budget
- **THEN** the controller SHALL claim and execute the permitted recovery recipe before recording a
  terminal stop
- **AND** a successful recovery SHALL re-enter normal whole-item execution

#### Scenario: Independent sibling continues while recovery is pending

- **WHEN** one item remains blocked for engine-owned recovery and a dependency-independent sibling
  is eligible
- **THEN** the controller SHALL continue the sibling
- **AND** the blocked item's attempt history SHALL remain durable and resumable

#### Scenario: Fresh completion supersedes stale recovery

- **WHEN** recovery preflight or cycle reconciliation freshly proves the item ready, merged, or
  closed before a claimed side effect executes
- **THEN** the controller SHALL forward-repair or abandon the item without running the recovery
- **AND** any interrupted started attempt SHALL be completed as `superseded`

#### Scenario: Deterministic recovery precedes model repair

- **WHEN** a workflow-state, implementation-CI, or workflow-engine diagnostic first blocks an item
- **THEN** the controller SHALL claim the class's deterministic redispatch/re-entry recipe first
- **AND** it SHALL invoke `repair_pipeline_item` only when the same current evidence returns and a
  later configured recipe retains budget

### Requirement: Authentication recovery SHALL verify rather than impersonate

The `environment-auth` recovery recipe SHALL perform a live non-interactive authentication probe
and SHALL report success only when it observes a non-empty authenticated GitHub actor. It MAY then
redispatch normal workflow state. It SHALL NOT log in, enter credentials, manufacture an identity,
clear a blocker after a failed probe, or describe an unverified no-op as reauthentication.

#### Scenario: Missing credentials remain an external operator action

- **WHEN** the live authentication probe fails or returns no actor
- **THEN** the recovery attempt SHALL fail with exact evidence and preserve the blocked state
- **AND** the outcome SHALL remain an environment/system failure rather than product authority

### Requirement: Mechanical remediation SHALL re-enter the normal whole-item pipeline

The `repair_pipeline_item` recovery executor SHALL receive the exact stage diagnostic and
authoritative candidate identity. It SHALL resolve the current stage, configured implementer
adapter, model, effort, and permissions; reconcile and, when safe, rematerialize the managed
worktree; invoke one shared bounded mechanical-remediation transaction; validate, commit, and push
a successful repair; and return success or exact failure evidence. The next normal whole-item
dispatch SHALL re-run all applicable review, CI, OpenSpec, pre-merge, and readiness gates. The
supervisor SHALL NOT branch on stage name, OpenSpec, finding category, or harness name.

The substantive implementer work inside that remediation transaction SHALL use the shared
harness-round helper either directly or via the pre-merge bounded auto-fix path that itself uses
the shared helper. Recovery-shell logic unique to attempt identity — durable pre-invocation
breadcrumb, ownership proof before adopting unpushed commits, idempotent reconciliation of
already-pushed marked repairs, and refusal to adopt unrelated human commits — MAY remain local to
`repair_pipeline_item` as a documented narrow exemption from calling the shared helper for the
shell itself. That exemption SHALL NOT reintroduce a private full implementer-round skeleton for
the substantive path.

#### Scenario: Repair uses the configured implementer coordinate

- **WHEN** `repair_pipeline_item` is claimed for a repository configured with any registered
  implementer adapter and supported model/effort coordinate
- **THEN** the per-item pipeline SHALL invoke that resolved coordinate through the adapter contract
- **AND** the supervisor SHALL remain unaware of the provider and model values

#### Scenario: Repair cannot bypass gates

- **WHEN** a mechanical repair creates and pushes a commit
- **THEN** the item SHALL re-enter normal execution against the new head
- **AND** it SHALL not become ready-to-deploy until all normal review and deterministic gates pass

#### Scenario: Substantive repair uses the shared harness-round stack

- **WHEN** `repair_pipeline_item` performs a substantive implementer repair
- **THEN** the implementer invoke/salvage/commit skeleton SHALL run through the shared harness-round
  helper or the shared-helper-backed auto-fix path
- **AND** the recovery shell MAY still own breadcrumb write/delete and post-crash reconciliation

#### Scenario: Recovery shell refuses unmarked human commits

- **WHEN** an unpushed commit exists on the claimed head without the attempt's ownership proof
  (breadcrumb/marker)
- **THEN** `repair_pipeline_item` SHALL refuse to amend, push, or adopt that commit as a repair
- **AND** SHALL return failure evidence rather than publishing unowned work

### Requirement: Recovery SHALL preserve existing authority boundaries

No recovery recipe SHALL merge, deploy, release, enter credentials, create an override, weaken a
review policy, or expand an authority grant. A repair transaction that cannot act safely within its
diagnostic and allowed paths SHALL return a typed no-action or failed result and consume its claimed
budget rather than broadening scope.

#### Scenario: Unsafe repair declines without widening authority

- **WHEN** the configured implementer determines that the requested repair requires product
  judgment, credentials, merge authority, or changes outside the permitted scope
- **THEN** it SHALL return a typed no-action result with that reason
- **AND** the controller SHALL NOT perform or authorize the gated action

### Requirement: Review non-convergence SHALL remain engine-owned through recovery
Actionable unresolved review findings SHALL project to the canonical reason code
`review-findings`, durable class `review-findings`, and disposition `recover`. This applies to
eligible exact recurrence, non-demotable surface recurrence, and non-demotable repair-bound ceiling
exhaustion. The diagnostic SHALL carry the reviewed SHA plus each blocking finding's stable key,
payload fingerprint, severity, title, location, and recommendation so `repair_pipeline_item` can act
without reconstructing intent from labels or prose. No such review-policy outcome SHALL create a
human hold or emit `human_intervention` without a separate current human-decision diagnostic.

#### Scenario: Exact recurrence enters the recovery controller
- **WHEN** a trusted prior-run review and its production fix transitions prove every blocker remains after candidate movement
- **THEN** the stage SHALL emit canonical `review-findings` recovery evidence
- **AND** the controller SHALL attempt its configured recipes before typed exhaustion

#### Scenario: Review diagnostic is mechanically actionable
- **WHEN** `repair_pipeline_item` receives a review non-convergence diagnostic
- **THEN** the evidence SHALL identify the reviewed SHA and the key, fingerprint, severity, location, and remediation for every blocker

#### Scenario: Review policy does not grant human authority
- **WHEN** recurrence, surface recurrence, or a round ceiling remains blocking
- **THEN** the controller SHALL NOT create a human hold or human-intervention event solely from that policy result

### Requirement: Stage diagnostics SHALL include review-findings as a canonical reason
The closed `pipeline/stage-diagnostic@1` reason-code set SHALL include `review-findings`, and its
exhaustive projection SHALL map only to durable class `review-findings` with disposition `recover`.
Unknown reason codes SHALL remain protocol failures.

#### Scenario: Review diagnostic projects exactly
- **WHEN** a valid diagnostic carries reason code and blocker kind `review-findings`
- **THEN** projection SHALL return durable class `review-findings` and disposition `recover`

### Requirement: Review recovery SHALL perform substantive repair before redispatch
The default policy for durable class `review-findings` SHALL contain only
`repair_pipeline_item`, with bounded retry and repeated-evidence budgets. Stage-local auto-loop
SHALL not consume this block. A successful repair SHALL prove a new remote candidate before the
normal whole-item pipeline is redispatched.

#### Scenario: Label clearing is not review repair
- **WHEN** a review finding remains blocking at the same candidate
- **THEN** clearing `blocked` and redispatching without candidate movement SHALL NOT satisfy recovery
- **AND** the first durable recovery action SHALL be substantive repair

