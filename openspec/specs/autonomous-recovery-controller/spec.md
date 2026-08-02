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

### Requirement: Missing control-critical event evidence SHALL fail safe and remain operator-visible

The autonomous recovery controller (or an equivalent recovery consumer) SHALL fail safe when it
cannot retrieve a required control-critical record — including blocker diagnostics / `blocker_set`
evidence, recovery claim or result records, or loop/run terminal state — because the run event
stream is missing, truncated, or marked elevated by write-health. It SHALL treat the persistence or
retrieval failure as an engine-owned control-plane defect path (typed `workflow-engine-defect` or
the existing unknown/malformed diagnostic failure path), SHALL surface the exact persistence failure
through operator-visible write-health / status / summary signals, and SHALL NOT invent an unrelated
recovery class, SHALL NOT create a human hold solely from missing evidence, SHALL NOT treat absence
as "blocker cleared" or "recovered," and SHALL NOT reconstruct authority or disposition from labels
or free-form prose. Existing fail-closed behavior for unknown diagnostics SHALL be preserved.

#### Scenario: Write-health elevated control-critical loss does not invent a human hold

- **WHEN** recovery needs a control-critical blocker or recovery claim record
- **AND** write-health for the run indicates control-critical append failure or the record is
  absent after a recorded stream failure
- **THEN** the controller SHALL NOT create a human hold solely from that missing evidence
- **AND** SHALL NOT project an unrelated blocker class from labels or prose
- **AND** the persistence failure SHALL remain visible via write-health or status/summary

#### Scenario: Missing recovery result does not mark recovered

- **WHEN** a recovery attempt was started but its result record cannot be retrieved because of
  event-stream write failure or truncation
- **THEN** the controller SHALL NOT record `recovered` solely from the missing result
- **AND** SHALL reconcile via the existing fail-safe / restart reconciliation path without
  inventing success

#### Scenario: Partial write after restart does not reclassify as a different class

- **WHEN** a process restarts and only partial `events.jsonl` lines plus elevated write-health are
  available for a blocked item
- **THEN** the controller SHALL fail closed or retain the prior durable ledger authority for
  classification
- **AND** SHALL NOT silently reclassify the item into an unrelated recovery class based on the
  incomplete event stream alone

### Requirement: Stage-diagnostic reason codes SHALL classify harness and forge failures mechanically

The closed `pipeline/stage-diagnostic@1` reason vocabulary SHALL remain the sole escalation
reason enum. The engine SHALL derive harness failure reasons from structured `HarnessResult`
flags — including at least `timed_out`, `spawn_error`, `capture_error`, `oversize_argv`,
`stdin_error`, and `throttled` — and SHALL derive forge/gh failure reasons from structured error
shapes including HTTP 5xx, rate-limit, authentication failure, capability refusal, network
timeouts, and output-contract failures. Classification SHALL NOT depend on free-form prose
matching as the primary signal. The vocabulary MAY gain additive members (for example explicit
timeout, harness-contract, transient-infra, external-wait, repair-budget-exhausted, or
human-context-required codes) when existing members would lossily collapse distinct budget or
metrics classes; the engine SHALL NOT introduce a competing parallel reason enum.

#### Scenario: Timed-out harness result maps without prose scraping

- **WHEN** a harness invocation returns `timed_out: true`
- **THEN** the emitted diagnostic reason SHALL be the mechanical timeout / harness mapping from
  the closed vocabulary
- **AND** classification SHALL NOT require matching free-form stderr text as the primary signal

#### Scenario: Capture or output-contract failure maps to harness-contract class

- **WHEN** a harness result sets `capture_error` or fails the output contract without a product
  finding
- **THEN** the diagnostic SHALL project to an engine-owned harness-contract or
  `workflow-engine-defect` reason
- **AND** SHALL NOT project to `human-decision-required`

#### Scenario: Gh HTTP 5xx maps to transient infrastructure class

- **WHEN** a gh API call fails with HTTP 504 (or other 5xx) during a non-attestation path
- **THEN** the failure SHALL classify as transient infrastructure under the canonical vocabulary
- **AND** a `transient-retryable` site SHALL be eligible for bounded retry before any park

#### Scenario: No competing reason enum is introduced

- **WHEN** the escalation classification modules are inspected
- **THEN** production authority classification SHALL use `pipeline/stage-diagnostic@1` reason
  codes (and pure projections of them)
- **AND** SHALL NOT introduce a second independent top-level reason enum for the same purpose

---

### Requirement: Transient infrastructure failures SHALL NOT park as product judgment

Transient infrastructure failures SHALL classify under an engine-owned recoverable reason and
disposition `recover` (or capacity/wait where applicable), including gh HTTP 5xx / rate-limit
during label edits or other non-attestation mutations, harness throttle, and network blips.
After bounded site-local retry exhaustion, the failure MAY escalate as a typed engine-owned or
environment failure. It SHALL NOT be represented as product judgment, SHALL NOT create a human
hold without the authority predicate, and SHALL NOT be the sole cause of a `needs-human` park
labeled as a product block.

#### Scenario: Label-edit 504 does not become a product hold

- **WHEN** a gh label edit fails with HTTP 504 and the site disposition is `transient-retryable`
- **THEN** the engine SHALL classify the failure as transient infrastructure
- **AND** SHALL retry within the configured budget
- **AND** SHALL NOT park the issue as a product or human-authority block solely because of that
  blip when a retry succeeds or when exhaustion remains typed engine-owned

#### Scenario: Repair-budget exhaustion stays engine-owned

- **WHEN** bounded recovery or site-local retry budget is exhausted for a mechanical class
- **THEN** the terminal outcome SHALL be a typed engine-owned failure or stop
- **AND** the controller SHALL NOT emit `human_intervention` solely from that exhaustion

---

### Requirement: Parallel taxonomies SHALL be exhaustive projections of the canonical reason vocabulary

`BlockerKind`, `HumanInterventionKind`, `PreMergeOfframpClass`, and `DurableBlockerClass` SHALL
be exhaustive pure projections of the canonical stage-diagnostic reason vocabulary (plus closed
site/context tags already carried on the diagnostic detail), or SHALL be retired from independent
authority classification. Loop recovery budgets and recovery-policy keys SHALL consume that same
closed durable class set projected from the vocabulary. No production path SHALL invent a
fifth independent reason taxonomy for escalation authority.

#### Scenario: Durable class projection is total over reason codes

- **WHEN** each closed stage-diagnostic reason code is projected
- **THEN** the projection SHALL yield exactly one `DurableBlockerClass` (or an explicit residual
  protocol-failure path for unknown codes)
- **AND** loop recovery budget keys SHALL use that class set

#### Scenario: Intervention and offramp kinds do not independently authorize holds

- **WHEN** a path would emit `HumanInterventionKind` or `PreMergeOfframpClass`
- **THEN** human-authority status SHALL still be determined only by the stage-diagnostic
  authority projection
- **AND** reporting kinds such as `review-non-convergence` SHALL NOT alone create a human hold
)

### Requirement: Recovery-attempt records SHALL expose extended stage-shared fields

The shipped recovery-attempt record used by the autonomous recovery controller SHALL remain the
single attempt family for supervisor recovery and stage-local recovery one-shots. Records SHALL
support (additively if not already present): action status, typed reason, attempt budget remaining,
last error, `next_attempt_at` / `not_before`, idempotency key, and terminal outcome among success,
failed, and superseded. Stage-local pre-merge and worktree recoveries SHALL claim through this
family via the stage-attempt ledger API rather than private books.

#### Scenario: Stage CI recovery claim is visible to supervisor hydration

- **WHEN** a pre-merge CI recovery action claims `(headSha, action)` through the stage-attempt ledger
- **THEN** the underlying recovery-attempt family SHALL retain that claim
- **AND** a supervisor or resumed process hydrating the same item/candidate SHALL observe the claim
  without reading a private stage-only JSON authority

#### Scenario: Extended fields round-trip across restart

- **WHEN** an attempt is persisted with typed reason, budget remaining, last error, and
  `next_attempt_at`
- **AND** the process restarts
- **THEN** hydration SHALL restore those fields for eligibility and operator visibility
- **AND** deferred attempts SHALL honor `next_attempt_at` without inventing a free retry

---

### Requirement: Stage-local terminalization SHALL NOT bypass the recovery ledger

Stage code paths SHALL NOT transition an item to `pipeline:needs-human` (or equivalent human hold)
based solely on locally inferred review recurrence, ceiling counts, or exhausted stage markers when
the durable recovery ledger and supervisor would still own a recoverable path. Review non-
convergence remains engine-owned through the `review-findings` class and controller recipes already
specified by this capability.

#### Scenario: Local recurrence inference does not short-circuit the controller

- **WHEN** a stage observes recurrence or ceiling evidence for current findings
- **AND** the autonomous recovery controller still has a permitted recoverable recipe or unconsumed
  budget for the projected class
- **THEN** the stage SHALL NOT apply a human hold solely from that local inference
- **AND** SHALL surface recovery-bound diagnostics for controller reconcile

### Requirement: implementation-ci recovery for no-commits SHALL try shared HEAD goal satisfaction first

When a blocked item’s diagnostic projects `no-commits` (or an equivalent implementation-outcome block) into the `implementation-ci` recovery class, the autonomous recovery controller’s policy for that class SHALL include a **deterministic first recipe** that invokes the shared `noop-advance-contract` evaluation with the **current stage’s** goal checks against the claimed HEAD. For implement-stage goal checks, the recipe SHALL verify the declared deliverable and worktree cleanliness via injectable deterministic probes (not hard-coded true). When evaluation returns **advance**, the controller SHALL **first** record attested durable evidence, and only then redispatch or clear the mechanical block — and SHALL **not** charge model-repair (`repair_pipeline_item` or equivalent) budget for that successful recipe. When evaluation returns **escalate**, goal checks cannot run, the worktree is dirty, or durable evidence cannot be recorded, the controller SHALL proceed to the next configured recipe for the class (including model repair when permitted) or typed exhaustion — fail closed, **without** clearing the block as repaired by this recipe. The recipe SHALL NOT add a recovery-only marker that bypasses normal product gates, and SHALL use the same verifier as normal stage execution (no parallel private satisfaction algorithm).

#### Scenario: First recipe is goal satisfaction for no-commits implementation-ci

- **WHEN** fresh reconciliation classifies a `no-commits` block as `implementation-ci` with recovery budget remaining
- **THEN** the controller SHALL claim and execute the shared goal-satisfaction recipe before model-repair recipes for that class
- **AND** the recipe SHALL call the shared noop-advance evaluation used by stage execution

#### Scenario: Satisfied HEAD advances without model-repair budget

- **WHEN** the goal-satisfaction recipe runs, the worktree is clean, the stage goal check is satisfied, and durable evidence is recorded
- **THEN** the controller SHALL continue/redispatch
- **AND** SHALL NOT decrement model-repair budget for that successful goal-satisfaction recipe

#### Scenario: Unsatisfied HEAD does not falsely clear the block

- **WHEN** the goal-satisfaction recipe runs and the shared evaluation returns **escalate**
- **THEN** the controller SHALL NOT mark the item repaired solely by this recipe
- **AND** SHALL advance to the next configured recipe or exhaust fail-closed under existing policy
- **AND** SHALL NOT bypass format, test, CI, OpenSpec, or review gates on subsequent paths

#### Scenario: Dirty worktree does not certify implement goal satisfaction

- **WHEN** the goal-satisfaction recipe runs for an implementing-stage no-commits block and the worktree is not clean
- **THEN** the recipe SHALL fail closed without clearing the blocked label
- **AND** SHALL NOT hard-code worktree cleanliness as true

#### Scenario: Evidence write failure preserves the block

- **WHEN** the shared evaluation returns **advance** but posting the attested evidence note fails
- **THEN** the recipe SHALL fail closed and SHALL NOT clear the blocked label

