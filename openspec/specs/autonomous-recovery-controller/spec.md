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

The controller SHALL create a human hold only when fresh dispatch evidence carries a canonical `human-decision-required` diagnostic whose structured blocker kind is also `human-decision-required` and whose non-empty authority evidence names a `product-decision` or `authority` finding key/fingerprint at the freshly observed candidate SHA, and only after the shared typed-request-resolution classifier has run on that evidence. A `product-decision` category SHALL NOT by itself create a human hold: the classifier SHALL auto-settle a reversible in-scope authorized recommendation, emit a `DecisionRequest` only for an irreducible product choice, emit a `CapabilityRequest` for missing information or input-requiring capability, and emit an `AuthorityRequest` only for missing protected authority. A `pipeline:blocked` label, a `blocked_needs_human` outcome without that diagnostic, stale or missing authority evidence, an exhausted mechanical budget, merge conflict, external dependency, or OpenSpec validation failure SHALL NOT satisfy this predicate. Engine-owned exhaustion SHALL enter Cooling or an external-condition wait without emitting `human_intervention`. Engine-owned exhaustion SHALL NOT terminate as a typed system failure, ownerless terminal, or supervisor STOP.

#### Scenario: Attested product decision creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with the matching structured blocker kind, sanctioned `product-decision` category, finding identity, and current reviewed SHA
- **AND** the shared classifier emits an irreducible `DecisionRequest`
- **THEN** the controller SHALL create a resumable human hold for that item
- **AND** the hold SHALL retain the diagnostic evidence and reconciled candidate identity

#### Scenario: Reversible product recommendation auto-settles

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with category `product-decision`
- **AND** the shared classifier auto-settles the recommendation
- **THEN** the controller SHALL NOT create a human hold
- **AND** SHALL NOT emit `human_intervention` for that recommendation

#### Scenario: Mechanical exhaustion is not human authority

- **WHEN** an OpenSpec or worktree recovery exhausts its configured budget
- **THEN** the controller SHALL enter Cooling or an external-condition wait
- **AND** it SHALL NOT create a human hold or emit `human_intervention`
- **AND** it SHALL NOT record an ownerless terminal or supervisor STOP solely for that exhaustion

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

The default policy for durable class `review-findings` SHALL list the deterministic preparatory action `unlink_engine_scratch` before `repair_pipeline_item`, with bounded retry and repeated-evidence budgets. Stage-local auto-loop SHALL not consume this block. Preparatory unlink SHALL remove engine-known scratch when present so the subsequent repair claim observes a product-clean tree; unlink alone SHALL NOT satisfy recovery for this class while blocking findings still apply at the same candidate. A successful recovery for this class SHALL prove a new remote candidate from substantive repair before the normal whole-item pipeline is redispatched.

Controller semantics for preparatory unlink under this class SHALL be:

- A successful prep unlink (scratch removed) or a no-scratch not-applicable result SHALL advance to `repair_pipeline_item` in the **same recovery sequence** (same blocked-recovery cycle when a candidate head exists).
- Preparatory unlink SHALL NOT mark the item recovered, SHALL NOT clear `pipeline:blocked` solely as findings success, and SHALL NOT consume the class `retry_budget` or repeated-evidence budget as if a repair attempt failed.
- When no engine-known scratch is present at claim time, the controller SHALL still claim `repair_pipeline_item` within the class budget (unlink no-op or not-applicable SHALL NOT mark the item recovered and SHALL NOT permanently prevent repair).

#### Scenario: Default review-findings policy orders unlink before repair

- **WHEN** the default recovery policy entry for durable class `review-findings` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item` in the recipes list
- **AND** a unit test SHALL fail if the default order lists only `repair_pipeline_item` or places implementer repair before unlink

#### Scenario: Challenge-response scratch unlinks before findings repair

- **WHEN** a recoverable diagnostic projects to `review-findings` with a current candidate
- **AND** the managed worktree porcelain includes engine-known scratch such as `artifacts/challenge-response-*.json` and no product dirt under the shared classifier
- **THEN** the controller SHALL claim and execute `unlink_engine_scratch` before claiming `repair_pipeline_item` for that recovery sequence
- **AND** the subsequent `repair_pipeline_item` attempt SHALL observe a worktree free of that engine-known scratch

#### Scenario: Unlink alone is not review repair

- **WHEN** `unlink_engine_scratch` runs for class `review-findings` and removes engine-known scratch
- **AND** blocking review findings still apply at the same candidate
- **THEN** that unlink attempt SHALL NOT count as successful substantive recovery for the findings class
- **AND** SHALL NOT clear `pipeline:blocked` solely as if the findings were fixed
- **AND** recovery SHALL proceed to `repair_pipeline_item` in the same recovery sequence rather than redispatch as recovered

#### Scenario: Prep unlink does not consume findings repair budget

- **WHEN** class is `review-findings` and preparatory `unlink_engine_scratch` runs (scratch removed or not-applicable)
- **THEN** `recovery_budgets_remaining` for `review-findings` SHALL be unchanged by that prep step
- **AND** `repeated_evidence_count` for the item SHALL be unchanged by that prep step (including on failed completion)
- **AND** a following `repair_pipeline_item` claim in the same sequence SHALL still be able to charge against the full configured class retry budget
- **AND** preparatory fall-through failures SHALL NOT exhaust `repeated_evidence_limit` before the configured implementer repair attempts complete

#### Scenario: No-scratch findings path still reaches repair

- **WHEN** class is `review-findings` and porcelain has no engine-known scratch paths
- **THEN** recovery SHALL still claim `repair_pipeline_item` within the class budget in the same recovery sequence
- **AND** SHALL NOT terminate as recovered solely because unlink was not applicable

#### Scenario: Label clearing is not review repair

- **WHEN** a review finding remains blocking at the same candidate
- **THEN** clearing `blocked` and redispatching without candidate movement SHALL NOT satisfy recovery
- **AND** successful recovery for the class SHALL require substantive repair that proves a new remote candidate

#### Scenario: Stale repair-only default migrates; custom policy preserved

- **WHEN** a persisted contract carries the exact pre-#1060 default `review-findings` entry with only `repair_pipeline_item` and the historical default budgets/backoff
- **THEN** `upgradeContractForRecovery` SHALL replace that entry with the current default recipes including preparatory unlink
- **WHEN** a persisted `review-findings` entry differs from that exact stale default (custom recipes, budgets, or backoff)
- **THEN** upgrade SHALL leave that custom entry unchanged

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
After bounded site-local retry exhaustion, the failure SHALL enter Cooling or an
external-condition wait, or a typed Capability Request when an unavailable external capability
is current. It SHALL NOT become a typed engine-owned terminal failure or supervisor STOP. It
SHALL NOT be represented as product judgment, SHALL NOT create a human hold without the
authority predicate, and SHALL NOT be the sole cause of a `needs-human` park labeled as a
product block.

#### Scenario: Label-edit 504 does not become a product hold

- **WHEN** a gh label edit fails with HTTP 504 and the site disposition is `transient-retryable`
- **THEN** the engine SHALL classify the failure as transient infrastructure
- **AND** SHALL retry within the configured budget
- **AND** SHALL NOT park the issue as a product or human-authority block solely because of that
  blip when a retry succeeds or when exhaustion remains typed engine-owned Cooling or wait

#### Scenario: Repair-budget exhaustion stays engine-owned

- **WHEN** bounded recovery or site-local retry budget is exhausted for a mechanical class
- **THEN** the outcome SHALL be Cooling or an external-condition wait
- **AND** the controller SHALL NOT emit `human_intervention` solely from that exhaustion
- **AND** the controller SHALL NOT record an ownerless terminal or supervisor STOP solely from
  that exhaustion

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

### Requirement: Exhausted shared format-repair SHALL surface harness-contract to recovery projection

The advance path SHALL emit a `pipeline/stage-diagnostic@1` diagnostic whose reason code is
`harness-contract` (or an exhaustive pure projection of that code through the closed
vocabulary) when a model-executed stage exhausts the shared stage-output format-repair budget
on a pure shape failure. The durable-loop / autonomous-recovery projection SHALL classify that
diagnostic as engine-owned (not `human_authority` / product hold) consistent with the existing
capture and output-contract → harness-contract mapping. Free-form blocker prose alone SHALL NOT
be the primary classification signal.

#### Scenario: Stage-emitted harness-contract after repair exhaustion projects engine-owned

- **WHEN** plan-revision or OpenSpec singularity blocks after shared format-repair exhaustion
  with diagnostic reason `harness-contract`
- **THEN** the recovery projection SHALL treat the failure as engine-owned
- **AND** SHALL NOT create a human-authority hold solely from that pure shape failure

#### Scenario: Classification does not require prose scraping

- **WHEN** the diagnostic carries structured reason `harness-contract` and blocker detail
- **THEN** projection SHALL use the structured reason code
- **AND** SHALL NOT require matching free-form reason text as the primary signal

### Requirement: Mechanical repair SHALL run the candidate-integrity protocol around head movement

The recovery path SHALL capture a pre-mutation candidate-integrity manifest, perform the repair transaction, capture a post-mutation manifest from the authoritative head/base, and classify the transition under the `candidate-integrity` capability whenever `repair_pipeline_item` (or equivalent recovery mechanical remediation) is about to move the authoritative candidate head. Classification SHALL use `mutation_method` of `recovery_repair` (or the method name assigned by that capability for recovery). Classification and disposition SHALL follow that capability: scope expansion and unverified comparison invalidate prior review and readiness and re-enter scoped review or bounded recovery; they MUST NOT silently authorize ready-to-deploy and MUST NOT invent a human-authority hold solely for the mechanical integrity class.

#### Scenario: Recovery repair captures before and after manifests

- **WHEN** recovery claims a mechanical repair that will commit and push a new candidate head
- **THEN** a pre-mutation candidate-integrity manifest SHALL be durable before the head-moving side effect
- **AND** after a successful push the path SHALL classify the before/after transition and emit a `candidate_integrity` event

#### Scenario: Recovery repair scope expansion does not skip whole-item gates

- **WHEN** recovery repair classifies as `scope_expansion`
- **THEN** the item SHALL re-enter normal whole-item execution against the new head with review and readiness evidence invalidated
- **AND** SHALL NOT become ready-to-deploy until candidate-integrity and normal gates pass on a later accepted head

#### Scenario: Recovery preserves authority boundaries under integrity failure

- **WHEN** integrity classification is `unverified` or `scope_expansion` after a recovery repair attempt
- **THEN** the controller SHALL NOT merge, override, weaken review policy, or create a human hold solely for that integrity class
- **AND** SHALL leave structured integrity diagnostics in durable evidence

### Requirement: Engine-scratch recover SHALL run before implementer repair and SHALL NOT mint a human hold

For recoverable diagnostics that project to engine-owned scratch or the `workflow-engine-defect` path, the default recovery policy SHALL list the deterministic action `unlink_engine_scratch` (see `engine-scratch-recover`) **before** `repair_pipeline_item` when both appear in the permitted sequence. The production controller SHALL claim and execute `unlink_engine_scratch` before claiming `repair_pipeline_item` when scratch-only evidence is current. Successful mechanical scratch recovery SHALL clear `pipeline:blocked` when the block was scratch-only, re-enter normal whole-item execution for the current stage, and SHALL NOT create a human hold or emit `human_intervention` solely for that recover. Exhaustion of the scratch recipe with remaining product dirt or a non-scratch engine defect SHALL follow existing engine-owned terminal failure rules without inventing product-judgment authority. Residual blocks that remain on the engine-scratch / factory-defect path SHALL stay in `workflow-engine-defect` (recover), not `human-decision-required`.

#### Scenario: Scratch-only path never selects implementer repair first

- **WHEN** current evidence is engine-scratch-only and both `unlink_engine_scratch` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `unlink_engine_scratch` before any implementer repair claim
- **AND** a successful unlink with clean product porcelain SHALL clear the mechanical block when present and resume without a human hold
- **AND** SHALL NOT invoke `repair_pipeline_item` for that attempt

#### Scenario: Default workflow-engine-defect policy orders unlink first

- **WHEN** the default recovery policy entry for `workflow-engine-defect` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item` in the recipes list
- **AND** a unit test SHALL fail if the default order selects implementer repair first for that class

#### Scenario: Human-decision-required still creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with matching authority evidence at the current candidate SHA
- **THEN** the controller SHALL still create a resumable human hold per existing human-hold rules
- **AND** `unlink_engine_scratch` SHALL NOT fire for that authority evidence alone

### Requirement: repair_pipeline_item failure evidence SHALL distinguish non-commit outcomes

When the `repair_pipeline_item` recovery executor completes without a committed and pushed repair (`fix-committed`), it SHALL return failure evidence that distinguishes at least: (1) implementer-reported clean no-change (`noop-clean` or equivalent), including any implementer diagnostic text; (2) commit or pre-invoke refusal caused by residual worktree dirt/porcelain, including a path summary when available from the shared porcelain classifier; (3) harness or executor error with no commit, including the non-success status identifier and a bounded harness or shared-round diagnostic/output tail when any output was captured. Evidence SHALL include a stable category identifier among `noop-clean`, `dirt-blocked`, `harness-error`, and `no-diagnostic`. The executor SHALL NOT collapse every non-success status into a single generic string that omits status and diagnostic when those values exist. When no diagnostic was captured, evidence SHALL state that absence explicitly rather than implying an implementer ran to a silent no-op. That evidence string SHALL be the value consumed by the recovery completion path and `loop_recovery_action_executed` event fields so the supervisor/dashboard see the typed failure, not only a local executor log line. Dirt-blocked classification SHALL use the shared porcelain classifier and recognized engine-scratch path set only; product dirt SHALL remain fail-closed; `artifacts/**` SHALL NOT be waived broadly. Committed-but-unpushed reconcile failures and harness crashes SHALL NOT be labeled as clean no-change.

#### Scenario: No-commit with harness output is debuggable

- **WHEN** the configured implementer or shared harness-round finishes without producing a committed and pushed repair
- **AND** a non-success status and harness or diagnostic output exist
- **THEN** the recovery result error or evidence string SHALL include that status, category `harness-error` (or the mapped non-noop category), and a bounded output/diagnostic tail
- **AND** SHALL NOT equal only the generic phrase that the implementer did not produce a committed and pushed repair with no further detail
- **AND** the supervisor event `loop_recovery_action_executed` for that attempt SHALL carry the same evidence/error content

#### Scenario: Implementer clean no-change remains explicit

- **WHEN** the repair path returns an implementer clean no-change / `noop-clean` outcome
- **THEN** the recovery result SHALL state that the implementer inspected the candidate and produced no verifiable change
- **AND** SHALL include category `noop-clean` and the implementer diagnostic when present

#### Scenario: Dirt-blocked repair discloses porcelain cause

- **WHEN** repair refuses to commit or invoke because residual worktree dirt/porcelain blocks a safe repair
- **THEN** the recovery result SHALL identify the dirt-blocked condition (category `dirt-blocked`)
- **AND** SHALL include a path summary or classification hint from the shared classifier when porcelain is available
- **AND** SHALL NOT treat product dirt as engine-scratch-only success

#### Scenario: Missing diagnostic is explicit

- **WHEN** repair ends without a committed push and no diagnostic or harness output was captured
- **THEN** evidence SHALL include the non-success status and an explicit statement that no diagnostic was captured
- **AND** SHALL use category `no-diagnostic` rather than implying a silent implementer no-op

### Requirement: Workflow-state recovery for a stale-tip push SHALL rematerialize or fast-forward
When a durable item blocks with class `workflow-state` because a push was rejected as non-fast-forward or the local managed worktree HEAD is behind the open-PR or verified remote head, the first permitted recipe SHALL rematerialize or fast-forward that managed worktree to the open-PR head when an open PR exists, otherwise the verified remote tip. After that currency action succeeds, recovery SHALL clear the mechanical block (when present) and continue the same item. The recipe SHALL NOT be `wait_and_retry`. The recipe SHALL NOT force-push. Existing rematerialize dirty / local-only unpushed refuse rules SHALL still apply when rematerialize would destroy operator work.

#### Scenario: Non-fast-forward loop recipe rematerializes then continues
- **WHEN** a durable item blocks from the #1038 non-fast-forward diagnostic (`workflow-state`, `push-failed`)
- **THEN** the compiled policy SHALL select `resync_workflow_state` (or the equivalent rematerialize / fast-forward recipe) first
- **AND** that recipe SHALL move the managed worktree HEAD to the open-PR or verified remote tip
- **AND** it SHALL NOT select `wait_and_retry`

#### Scenario: Waiting cannot recover a stale tip
- **WHEN** the same #1038 fixture is classified as `workflow-state`
- **THEN** durable projection SHALL NOT yield `transient-rate-limit`
- **AND** the recovery executor SHALL NOT treat elapsed backoff as a successful currency repair

#### Scenario: Dirty or local-only unique work still refuses destroy
- **WHEN** rematerialize or hard reset to the PR / remote head would destroy a dirty or local-only unpushed product candidate
- **THEN** the recipe SHALL refuse that destroy
- **AND** the attempt SHALL fail typed (`dirty-worktree` or `local-only-unpushed`) without a force-push
- **AND** the mechanical blocked label SHALL remain
- **AND** the durable class SHALL stay `workflow-state`
- **AND** the next compiled recipe SHALL NOT be `wait_and_retry`

#### Scenario: Recovery resolves open-PR head before origin branch
- **WHEN** `resync_workflow_state` runs for a stale-tip / non-fast-forward diagnostic
- **AND** an open PR exists for the managed branch
- **THEN** the target SHA SHALL be that open-PR head
- **AND** the recipe SHALL NOT reset or rematerialize until that SHA is verified
- **AND** when no open PR exists, the recipe SHALL fetch and verify `origin/<branch>` (or `FETCH_HEAD` from that fetch) before any reset

#### Scenario: Unverified remote head refuses without mutate
- **WHEN** neither an open-PR head nor `origin/<branch>` can be verified
- **THEN** the recipe SHALL fail typed (`unverified-remote-head`)
- **AND** it SHALL NOT reset, rematerialize, or force-push
- **AND** it SHALL NOT select `wait_and_retry`

### Requirement: Dead-holder interrupt SHALL resume before restart_workflow_engine

When fresh evidence is a resume-eligible interrupt (dead holder, leftover mid-stage labels, no live process identity), the controller SHALL claim a deterministic resume of the same item as the first recipe. That resume SHALL use the existing implementing-resume / stranded-stage recovery path (worktree + labels + ledger). The controller SHALL NOT claim `restart_workflow_engine` as the first recipe for that evidence. The controller SHALL NOT consume the `workflow-engine-defect` class budget for that interrupt. `unlink_engine_scratch` MAY still run when porcelain is scratch-only; a no-op unlink SHALL NOT escalate the interrupt into `workflow-engine-defect`.

#### Scenario: First recipe after kill is resume

- **WHEN** the controller observes issue N at `pipeline:implementing` with a dead holder
- **THEN** the first claimed recovery action SHALL be resume of issue N
- **AND** it SHALL NOT be `restart_workflow_engine`
- **AND** the `workflow-engine-defect` remaining budget SHALL be unchanged by that interrupt

#### Scenario: No-op scratch unlink does not escalate

- **WHEN** `unlink_engine_scratch` runs after a dead-holder interrupt and unlinks nothing
- **THEN** the controller SHALL continue the resume path for the same item
- **AND** it SHALL NOT treat the no-op as a `workflow-engine-defect` that burns `restart_workflow_engine`

#### Scenario: Budget burn to zero fails the fixture

- **WHEN** a fixture replays the 2026-08-16 kill-then-re-ship sequence (dead lock, no-op unlink, reused loop id)
- **THEN** the fixture SHALL fail if `restart_workflow_engine` is claimed
- **AND** the fixture SHALL fail if the `workflow-engine-defect` class budget reaches zero

### Requirement: Owned harness leftovers SHALL checkpoint before implementer repair and SHALL NOT mint a human hold

For recoverable diagnostics whose current evidence is pipeline-owned harness leftovers (see `harness-mutation-ownership`), the default recovery policy SHALL list the deterministic action `checkpoint_owned_harness_dirt` after `unlink_engine_scratch` when both appear, and **before** `repair_pipeline_item`. The production controller SHALL claim and execute `checkpoint_owned_harness_dirt` when owned-leftover evidence is current. That action SHALL commit only the owned leftover path set under existing salvage authorship rules, SHALL NOT auto-format those paths as a substitute for checkpoint, and SHALL NOT invoke `repair_pipeline_item` for that attempt when checkpoint clears owned leftovers and no unknown product dirt remains. Successful checkpoint SHALL re-enter normal whole-item execution for the current stage (including implementing-resume completeness: re-invoke implementer when the deliverable is unsatisfied) and SHALL NOT create a human hold or emit `human_intervention` solely for that recover. The same recipe SHALL apply to `pipeline single`, durable loop, and train. Residual blocks that remain on owned leftovers after checkpoint failure SHALL stay engine-owned (`harness-failure` → `workflow-engine-defect` recover), not `needs-human` or `human-decision-required`. Unknown product dirt after checkpoint SHALL remain fail-closed as unknown dirt.

#### Scenario: Owned leftovers select checkpoint before implementer repair

- **WHEN** current evidence is pipeline-owned harness leftovers and both `checkpoint_owned_harness_dirt` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `checkpoint_owned_harness_dirt` before any implementer repair claim
- **AND** a successful checkpoint with no remaining unknown product dirt SHALL NOT invoke `repair_pipeline_item` for that attempt
- **AND** SHALL NOT create a human hold solely for that recover

#### Scenario: Default policy orders unlink, then checkpoint, then repair

- **WHEN** the default recovery policy entry used for engine-owned leftover / `workflow-engine-defect` evidence is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `checkpoint_owned_harness_dirt`
- **AND** `checkpoint_owned_harness_dirt` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for owned-leftover evidence

#### Scenario: Single-item and multi-item entry points share the recipe

- **WHEN** `pipeline single` re-enters an interrupted implement with owned leftovers
- **AND** when a durable loop or train recovery pass observes the same evidence
- **THEN** both SHALL claim `checkpoint_owned_harness_dirt` rather than parking as `needs-human`
- **AND** SHALL NOT require an operator to commit the leftovers

#### Scenario: Unknown dirt after checkpoint does not become a human-authority hold for leftovers

- **WHEN** checkpoint commits owned path `P` and unknown product path `U` remains
- **THEN** the leftover recover SHALL NOT be recorded as `human-decision-required` solely because `P` existed
- **AND** unknown-dirt refusal for `U` MAY still apply

### Requirement: Unpublished stage commits SHALL publish before implementer repair

For recoverable diagnostics whose current evidence is a publishable unpublished stage commit (see `unpublished-stage-commit-publish`), the default recovery policy SHALL list the deterministic action `publish_unpublished_stage_commit` after `checkpoint_owned_harness_dirt` when both appear, and **before** `repair_pipeline_item`. The production controller SHALL claim and execute `publish_unpublished_stage_commit` when that evidence is current. The action SHALL reuse the existing post-implement publish sequence (gates, non-force push, create-or-find PR, engine-owned `implementing → review-1` transition). It SHALL NOT invoke `repair_pipeline_item` for that attempt when publish succeeds. Successful publish SHALL NOT create a human hold or emit `human_intervention` solely for the originating timeout. The same recipe SHALL apply to `pipeline single`, durable loop, `recover-parked`, and train. Train SHALL receive that recipe as a RecoverySupervisor episode inside the advance wave, not as a train-local `recover-parked` pass. LLM repair SHALL NOT be the first recoverer for this class.

#### Scenario: Unpublished commit selects publish before implementer repair

- **WHEN** current evidence is a publishable unpublished stage commit and both `publish_unpublished_stage_commit` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `publish_unpublished_stage_commit` before any implementer repair claim
- **AND** a successful publish SHALL NOT invoke `repair_pipeline_item` for that attempt
- **AND** SHALL NOT create a human hold solely for that recover

#### Scenario: Default policy orders unlink, checkpoint, publish, then repair

- **WHEN** the default recovery policy entry used for unpublished-timeout / `workflow-engine-defect` evidence of this class is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `checkpoint_owned_harness_dirt`
- **AND** `checkpoint_owned_harness_dirt` SHALL appear before `publish_unpublished_stage_commit`
- **AND** `publish_unpublished_stage_commit` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for publishable unpublished-commit evidence

#### Scenario: Single-item and multi-item entry points share the recipe

- **WHEN** `pipeline single` observes a timeout park with a publishable unpublished commit
- **AND** when a durable loop, train RecoverySupervisor episode, or `pipeline recover-parked` observes the same evidence
- **THEN** each SHALL claim `publish_unpublished_stage_commit` rather than parking as `needs-human` or fail-closing on missing PR
- **AND** SHALL NOT require an operator to push, open the PR, or edit the stage label

### Requirement: Stage diagnostics SHALL include harness-background-wait as an additive reason

The closed `pipeline/stage-diagnostic@1` reason vocabulary SHALL include additive member
`harness-background-wait`. The engine SHALL derive that reason from structured lifecycle
evidence — a typed complete or fail event without notification delivery or foreground-join inside
the effective grace — and SHALL NOT derive it from `HarnessResult.timed_out`, from generic
inactivity, or from free-form transcript matching. Projection of `harness-background-wait` SHALL
be total: exactly one `DurableBlockerClass` and disposition, engine-owned (`workflow-engine-defect`,
disposition `recover`), never `human_authority` from this reason alone. Unknown codes SHALL remain
protocol failures. The engine SHALL NOT introduce a competing parallel reason enum.

#### Scenario: Lifecycle miss maps without prose scraping

- **WHEN** a harness invocation returns structured lifecycle evidence of complete-or-fail without
  delivery or join inside the effective grace
- **THEN** the emitted diagnostic reason SHALL be `harness-background-wait`
- **AND** classification SHALL NOT require matching free-form stderr or transcript text as the
  primary signal

#### Scenario: timed_out does not become harness-background-wait

- **WHEN** a harness invocation returns `timed_out: true` without typed complete-or-fail-without-join
  evidence
- **THEN** the diagnostic reason SHALL remain the mechanical timeout mapping (`harness-timeout`)
- **AND** SHALL NOT be `harness-background-wait`

#### Scenario: Projection is total and engine-owned

- **WHEN** `harness-background-wait` is projected
- **THEN** the projection SHALL yield `DurableBlockerClass` `workflow-engine-defect` and
  disposition `recover`
- **AND** SHALL NOT yield `human_authority` or `human-decision-required` from this reason alone

### Requirement: harness-background-wait SHALL NOT retry the same adapter on the same fingerprint

For diagnostics whose reason is `harness-background-wait`, the recovery policy SHALL NOT claim a
recipe that re-invokes the same adapter on the same invocation fingerprint. Salvage of uncommitted
work MAY still run. Publication, recover-parked, and `publish_unpublished_stage_commit` transitions
SHALL remain unchanged by this reason. Selecting a different adapter SHALL require an existing
explicit harness policy. LLM repair SHALL NOT be the first recoverer for this class. This reason
SHALL NOT mint a human hold.

#### Scenario: Same-adapter implementer repair is not selected

- **WHEN** current evidence is `harness-background-wait` for adapter A and invocation fingerprint F
- **THEN** the controller SHALL NOT start a recipe that re-invokes adapter A on fingerprint F
- **AND** SHALL NOT create a human hold solely for that diagnostic

#### Scenario: This reason does not open the unpublished-commit publish path

- **WHEN** a `harness-background-wait` diagnostic is recorded and a salvage commit exists
- **THEN** this reason SHALL NOT by itself claim `publish_unpublished_stage_commit`
- **AND** SHALL NOT transition the item to `review-1`

### Requirement: Provider credential failure SHALL project to environment-auth, not workflow-engine-defect

The engine SHALL classify provider credential failures as `pipeline/stage-diagnostic@1` reason `environment-auth` when production preflight sets `preflight_reason_code` to `environment-auth`, when structured provider status after spawn reports an invalidated or unauthenticated session, or when an exact allowlisted compatibility marker such as `refresh_token_invalidated` is present. Those diagnostics SHALL project to durable class `environment-auth` with disposition recover. Recovery SHALL use the existing `verify_authentication` recipe. The durable stop theme SHALL be the existing string `environment-auth`. The engine SHALL NOT add a new `DurableBlockerClass` or stop-theme member for this class. The engine SHALL NOT project these failures to `harness-contract` or `workflow-engine-defect`. Arbitrary stderr prose SHALL NOT be sufficient for this class.

#### Scenario: Unauthenticated preflight does not become harness-contract

- **WHEN** a harness result carries `preflight_reason_code` `environment-auth`
- **THEN** the diagnostic reason SHALL be `environment-auth`
- **AND** the durable class and stop theme SHALL be `environment-auth`
- **AND** SHALL NOT be `harness-contract` or `workflow-engine-defect`

#### Scenario: Revoked refresh token after spawn is environment-auth

- **WHEN** a spawned harness returns structured provider status or an allowlisted `refresh_token_invalidated` marker
- **THEN** the diagnostic reason SHALL be `environment-auth`
- **AND** recovery policy for that class SHALL list `verify_authentication`
- **AND** a run-fatal stop recorded for that item SHALL use theme `environment-auth`

#### Scenario: Unallowlisted prose is not environment-auth

- **WHEN** a harness result has a non-zero exit and stderr that only contains unallowlisted prose such as `please log in`
- **AND** `preflight_reason_code` is absent and no structured provider status or allowlisted marker is present
- **THEN** classification SHALL NOT emit `environment-auth` from that prose
- **AND** SHALL keep the existing mechanical mapping (`harness-contract` or equivalent)

#### Scenario: No new theme string is introduced

- **WHEN** the closed `DurableBlockerClass` set is inspected after this change
- **THEN** it SHALL still contain `environment-auth` as the credential-failure theme
- **AND** SHALL NOT contain a newly minted auth-specific theme token

### Requirement: Recovery SHALL observe typed production-preflight refusal and SHALL NOT select inapplicable worktree recipes

The recovery controller SHALL observe a typed production-preflight refusal through the existing stage-diagnostic fields (`preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, bounded message). The controller SHALL NOT select `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, force-push, or worktree-removal when the harness never started and the worktree is clean. Inapplicable recipes SHALL NOT count as recovery exhaustion. The controller SHALL NOT invent a harness session or switch adapters. Mechanical routing failure SHALL remain engine-owned recover and SHALL NOT become human authority. A true unavailable capability that requires supplied input SHALL become a typed `CapabilityRequest`. An external condition that is currently false SHALL become an external-condition wait. Product failure classification SHALL NOT grant merge, release, destructive, security, or implicit adapter-fallback authority.

#### Scenario: Never-started harness does not select scratch or dirt recipes

- **WHEN** recovery observes `preflight_failed: true` and the worktree is clean
- **THEN** the controller SHALL NOT claim `unlink_engine_scratch`
- **AND** SHALL NOT claim `checkpoint_owned_harness_dirt`
- **AND** SHALL NOT force-push
- **AND** SHALL NOT remove the worktree

#### Scenario: Inapplicable recipes are not exhaustion

- **WHEN** every remaining recovery recipe is inapplicable because the harness never started
- **THEN** the controller SHALL NOT record recovery exhaustion for those skipped recipes
- **AND** the Logical Operation SHALL remain owned as typed wait or supervised recover

#### Scenario: Mechanical omitted or malformed routing stays engine-owned

- **WHEN** the refusal is an omitted or malformed required lifecycle declaration
- **THEN** the diagnostic SHALL be `capability-refusal` with disposition recover
- **AND** SHALL NOT project to human authority
- **AND** SHALL NOT create a `CapabilityRequest` solely for that mechanical routing failure

#### Scenario: True unavailable capability that needs input becomes CapabilityRequest

- **WHEN** progress requires an unavailable external capability or information that the operator must supply
- **THEN** the pipeline SHALL emit a typed `CapabilityRequest`
- **AND** SHALL NOT treat that request as merge, release, or destructive authority

#### Scenario: External condition wait is not human authority

- **WHEN** the refusal is an external condition that is currently false (including environment-auth)
- **THEN** recovery SHALL use the existing wait or `verify_authentication` path
- **AND** SHALL NOT park the item as human authority solely because the condition is false

### Requirement: auto_recover SHALL be a RecoverySupervisor compatibility adapter

`auto_recover` SHALL claim or resume the Recovery Episode of the owning Logical Operation. It SHALL report a typed operation observation. It SHALL NOT own an independent retry budget, comment-counted cap, or terminal outcome. `auto_recovery_max_retries` SHALL NOT permanently block an issue or end RecoverySupervisor ownership. Worktree removal and reset-to-ready MAY remain RecoverySupervisor treatments when the candidate has no commits ahead and dirt is pipeline-owned scratch. They SHALL NOT run as a second controller. RecoverySupervisor SHALL remain the sole lifecycle owner. Recipe selection named by this capability SHALL be RecoverySupervisor treatment, not a separate controller.

#### Scenario: Independent auto-recovery cap cannot terminalize

- **WHEN** implementation produced no commits ahead of base
- **AND** prior auto-recovery comments equal `auto_recovery_max_retries`
- **THEN** `auto_recover` SHALL emit an observation
- **AND** SHALL NOT post a terminal auto-recovery-limit outcome that ends ownership
- **AND** RecoverySupervisor SHALL retain the Logical Operation as Cooling or another owned treatment

#### Scenario: auto_recover claims the same episode

- **WHEN** advance invokes `auto_recover` for issue `N`
- **THEN** it SHALL claim or resume the Recovery Episode for that issue's Logical Operation
- **AND** SHALL NOT mint a second independent recovery identity

#### Scenario: Scratch-only no-commit recovery remains a treatment

- **WHEN** RecoverySupervisor selects a reset-to-ready treatment
- **AND** porcelain is pipeline-owned scratch only
- **AND** no commits exist ahead of base
- **THEN** the compatibility adapter MAY remove the managed worktree and return the issue to `pipeline:ready` as that treatment
- **AND** the Logical Operation SHALL remain owned

### Requirement: The controller SHALL reconcile after every recovery action and SHALL keep SHA and rebase drift owned

After every recovery action, the controller SHALL reconcile run ownership, candidate identity, worktree state, and PR identity against the declared observers before the next adapter attempt or human hold. Claimed candidate SHA unequal to on-disk HEAD, including a worktree mid-rebase with staged product dirt, SHALL be local/remote drift. `repair_pipeline_item` SHALL NOT refuse as human STOP solely for that drift. Unfinished rebase SHALL NOT be treated as a completed archive candidate. The OpenSpec dirty-before-archive fail-closed SHALL remain when product dirt is present. Recovery recipes MAY abort an unfinished rebase or rematerialize after that observation. Those recipes SHALL NOT run inside the observer.

#### Scenario: Post-recovery reconcile runs before the next attempt

- **WHEN** a recovery recipe rematerializes a worktree or aborts an unfinished rebase
- **THEN** the controller SHALL observe candidate SHA, worktree porcelain, and PR identity before the next adapter attempt
- **AND** SHALL NOT treat the recipe as verified completion of the original mutation

#### Scenario: Claimed SHA versus on-disk HEAD is not human STOP

- **WHEN** a repair claim names SHA A
- **AND** the worktree HEAD is SHA B with unfinished rebase and staged product dirt
- **THEN** the controller SHALL record local/remote drift
- **AND** SHALL NOT refuse as `needs-human` solely for that mismatch
- **AND** SHALL NOT skip dirty-before-archive fail-closed

#### Scenario: Unfinished rebase is observed before archive retry

- **WHEN** recovery sees an unfinished rebase after a completed archive side effect
- **THEN** the controller SHALL observe the rebase as in-progress
- **AND** SHALL NOT replay the archive
- **AND** SHALL keep the Logical Operation owned

#### Scenario: Unfinished rebase stays unschedulable until a clean observation

- **WHEN** reconciliation records identity-mismatch for an unfinished rebase or product dirt
- **AND** the next action is `reconstruct`
- **THEN** the item SHALL remain unschedulable for adapters
- **AND** SHALL stay unschedulable until a later observation proves a clean, non-rebasing worktree

### Requirement: Inapplicable deterministic recipes SHALL NOT consume substantive repair budget

When RecoverySupervisor selects recipes named by this capability, it SHALL evaluate applicability from live evidence and declared invariants before claiming a recipe. An inapplicable deterministic recipe SHALL be recorded as a skip. It SHALL NOT consume the substantive repair budget of a later applicable recipe. `auto_recover` SHALL claim or resume the same Recovery Episode and SHALL NOT keep a private class-wide budget that hides later recipes.

#### Scenario: Inapplicable first recipe leaves repair reachable

- **WHEN** the configured order is a deterministic prep or verify recipe followed by `repair_pipeline_item`
- **AND** the first recipe's preconditions are false
- **THEN** RecoverySupervisor SHALL skip that recipe without charging `repair_pipeline_item`
- **AND** `repair_pipeline_item` SHALL remain reachable in production order

#### Scenario: auto_recover does not spend a private class-wide cap as authority

- **WHEN** `auto_recover` observes an inapplicable deterministic recipe
- **THEN** it SHALL record the skip on the Recovery Episode
- **AND** SHALL NOT decrement a private `auto_recovery_max_retries` or class-wide budget as the reason a later recipe is unreachable

