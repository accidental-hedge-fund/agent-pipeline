# human-question-handoff Specification

## Purpose
TBD - created by archiving change durable-resumable-human-question-handoffs. Update Purpose after archive.

## Requirements

### Requirement: A versioned handoff schema SHALL represent question identity, class, scope, eligibility, lifecycle, answer provenance, and resume target

The engine SHALL define a schema-versioned human-question handoff record (`schema_version: 1`) that includes at least: stable `handoff_id`; repository/domain identity; issue number; optional run and attempt identifiers; blocked stage; non-empty bounded `question` text; escalation `reason`; closed `handoff_class`; `authority_mode` of `authority` or `non_authority`; candidate SHA and optional plan/dossier/policy/spec content hashes; required responder capability or authority obligations; eligibility or authorization-resolution evidence; created time; optional expiration; supersession links; current lifecycle status; authenticated responder identity and identity source when answered; decision (`answer` or `reject`); answer payload or rejection reason; answer timestamp; bounded supporting evidence; deterministic `resume_target`; and resume preconditions. Consumers SHALL reject unknown `schema_version` values for resume/advance while still preserving the raw record for audit dump.

#### Scenario: Complete v1 record validates

- **WHEN** a handoff document carries `schema_version: 1` and all required identity, question, class, scope, eligibility, lifecycle, and resume fields
- **THEN** schema validation SHALL succeed
- **AND** the record SHALL be eligible for persistence

#### Scenario: Missing question fails validation

- **WHEN** a create attempt supplies an empty or whitespace-only `question`
- **THEN** validation SHALL fail
- **AND** no handoff record SHALL be persisted

#### Scenario: Unknown schema_version fails closed for resume

- **WHEN** resume validation reads a handoff whose `schema_version` is not supported
- **THEN** resume SHALL be refused
- **AND** the item SHALL NOT advance
- **AND** evidence SHALL preserve the raw record and parse failure

---

### Requirement: Handoff lifecycle SHALL complement labels without a parallel workflow state machine

Creating, answering, rejecting, superseding, or expiring a handoff SHALL NOT introduce a new pipeline stage label for handoff status. GitHub labels SHALL remain the authoritative workflow stage. Handoff `status` SHALL be one of `pending`, `answered`, `rejected`, `superseded`, or `expired`. Create SHALL preserve the active blocked or `needs-human` behavior already established by the stage that parked the item.

#### Scenario: Create does not mint a handoff stage label

- **WHEN** a handoff is created for an item parked at `needs-human`
- **THEN** the engine SHALL NOT add a stage label whose sole purpose is handoff lifecycle
- **AND** the item SHALL remain at the same workflow stage pending human action

#### Scenario: Answer alone does not reach ready-to-deploy

- **WHEN** an eligible responder answers a pending handoff
- **AND** resume revalidation has not yet succeeded through the normal advance path
- **THEN** the item SHALL NOT transition to `ready-to-deploy` solely because an answer was recorded

---

### Requirement: Handoff classes and authority mode SHALL be closed and fail closed for invented product judgment

`handoff_class` SHALL be drawn from the closed set: `missing_context`, `product_judgment`, `domain_expertise`, `risk_authority`, `override_disposition`, `manual_repair`, `unknown`. Authority-bearing creates (`authority_mode: authority`, or classes `product_judgment`, `risk_authority`, `override_disposition` when used as authority) SHALL require current candidate-bound authority evidence: a valid `human-decision-required` diagnostic carrying finding key, fingerprint, and reviewed SHA, or an already-specified policy-bound authority gate (for example an active pre-code attestation wait). Generic engine failure or recovery exhaustion without a decision question SHALL NOT create an authority-bearing product-judgment handoff; when a human is still required, the engine SHALL type the handoff as non-authority `manual_repair` (or refuse create if no human action is defined).

#### Scenario: Authority-bearing create requires human-decision-required evidence

- **WHEN** create requests `authority_mode: authority` with class `product_judgment`
- **AND** no current `human-decision-required` diagnostic with key, fingerprint, and reviewed SHA is present
- **AND** no equivalent policy-bound authority gate is active
- **THEN** create SHALL fail closed
- **AND** no authority-bearing handoff SHALL be stored

#### Scenario: Engine exhaustion without a decision question is manual-repair non-authority

- **WHEN** automation is exhausted without a bounded product decision question
- **AND** a human must still perform manual repair
- **THEN** any created handoff SHALL use `handoff_class: manual_repair` and `authority_mode: non_authority`
- **AND** SHALL NOT use `product_judgment` as a masquerade for exhaustion

#### Scenario: Unknown class never grants authority

- **WHEN** a handoff is recorded with `handoff_class: unknown`
- **THEN** `authority_mode` SHALL be `non_authority`
- **AND** an answer to that handoff SHALL NOT satisfy approval, attestation, or finding-override requirements

---

### Requirement: Create SHALL require a bounded question, required capability or authority, and current candidate evidence

The create path SHALL accept a handoff only when: (1) `question` is non-empty and within the documented length bound; (2) `required_capability` or authority obligations are present; (3) current candidate evidence is present — at least `candidate_sha` when a PR/worktree tip exists, and plan/dossier/policy/spec hashes when those artifacts are in scope for the wait. Create SHALL be a pure validation over injectable inputs plus durable write seams; unit tests SHALL exercise create without real network or git.

#### Scenario: Create succeeds with complete non-authority context handoff

- **WHEN** create supplies a bounded question, class `missing_context`, non-authority mode, required capability, and current candidate SHA
- **THEN** a `pending` handoff SHALL be persisted with those fields
- **AND** an append-only create audit event SHALL be recorded

#### Scenario: Create fails without candidate evidence when a tip exists

- **WHEN** a PR head SHA is available in the current context
- **AND** create omits `candidate_sha`
- **THEN** create SHALL fail closed
- **AND** no handoff SHALL be stored

---

### Requirement: Eligible-responder resolution SHALL be deterministic and authority answers SHALL reuse authenticated identity policy

The engine SHALL resolve eligible responders with a pure function over repository-owned policy inputs and injectable identity/ownership adapters. For authority-bearing handoffs, authorization SHALL reuse the same authenticated identity source and authorized-approver resolution patterns as pre-code attestation (#575): an unidentified or unauthorized actor SHALL NOT satisfy the handoff. For non-authority handoffs, a successful context answer SHALL record the actor and SHALL NOT be treated as approval, attestation, or finding override. When policy cannot resolve any eligible actor for an authority-bearing handoff, create or answer SHALL fail closed with unresolved-routing evidence; the engine SHALL NOT invent an assignee.

#### Scenario: Authorized actor answers authority-bearing handoff

- **WHEN** an authority-bearing pending handoff's resolution includes actor `alice`
- **AND** the authenticated actor is `alice`
- **AND** answer payload is valid
- **THEN** the handoff status SHALL become `answered`
- **AND** the record SHALL store actor, identity source, and authorization resolution evidence

#### Scenario: Unauthorized actor cannot satisfy authority-bearing handoff

- **WHEN** an authority-bearing pending handoff is answered by authenticated actor `bob`
- **AND** `bob` is not covered by resolution for the handoff obligations
- **THEN** the answer SHALL be refused
- **AND** status SHALL remain `pending`
- **AND** evidence SHALL record the unauthorized attempt

#### Scenario: Unidentified actor is refused for authority-bearing handoff

- **WHEN** an authority-bearing answer is attempted with no authenticated identity
- **THEN** the answer SHALL be refused
- **AND** status SHALL remain `pending`

#### Scenario: Non-authority context answer is not approval

- **WHEN** a non-authority `missing_context` handoff is answered by an eligible actor
- **THEN** the handoff MAY become `answered`
- **AND** the engine SHALL NOT treat that answer as pre-code attestation approve
- **AND** SHALL NOT record a finding override or suppress a blocking finding solely from that answer

#### Scenario: Unresolved authority routing fails closed

- **WHEN** create or answer for an authority-bearing handoff cannot resolve any eligible actor under effective policy
- **THEN** the operation SHALL fail closed with unresolved-routing evidence
- **AND** the engine SHALL NOT assign a default human

---

### Requirement: Answer, reject, and supersede SHALL be idempotent and append-only audited

Each successful create, answer, reject, supersede, expire, and resume-attempt outcome SHALL append an immutable audit event. Duplicate answer, reject, or supersede deliveries with the same idempotency key or equivalent payload SHALL leave the handoff in the same terminal semantic state and SHALL NOT double-apply side effects. Reject SHALL set status `rejected` without advancing the item. Supersede SHALL set the prior handoff to `superseded`, link `superseded_by`, and require a new pending handoff (or explicit superseding record) for any further answer.

#### Scenario: Duplicate answer is idempotent

- **WHEN** the same valid answer payload is delivered twice for handoff H
- **THEN** H SHALL remain `answered` with a single semantic answer body
- **AND** the second delivery SHALL NOT advance the item again solely by duplication
- **AND** audit MAY record a duplicate marker

#### Scenario: Reject preserves block

- **WHEN** an eligible actor rejects a pending handoff
- **THEN** status SHALL become `rejected`
- **AND** the item SHALL remain blocked or at `needs-human`
- **AND** the item SHALL NOT advance

#### Scenario: Supersede invalidates prior answer path

- **WHEN** pending handoff H1 is superseded by H2
- **THEN** H1 status SHALL be `superseded`
- **AND** an answer to H1 after supersession SHALL be refused for resume
- **AND** only H2 (when answered and valid) MAY satisfy resume for that question lineage

---

### Requirement: Resume SHALL revalidate currency and refuse stale or superseded answers

Before any advance that depends on a handoff answer, the engine SHALL run resume validation that verifies: status is `answered`; the handoff is not superseded or expired; `candidate_sha` matches the current candidate tip (default: mismatch refuses); bound dossier/policy/spec content hashes match current artifacts when present; for authority-bearing handoffs the recorded responder remains authorized under current policy; `resume_target` is unambiguous; and stage preconditions for re-entry hold. On any failure the engine SHALL refuse resume, preserve labels and durable state, and record refusal evidence. A stale, expired, or superseded answer SHALL never advance the item.

#### Scenario: Successful resume with current SHA and hashes

- **WHEN** an answered handoff's candidate SHA and bound artifact hashes match the current context
- **AND** expiration and supersession checks pass
- **AND** resume_target preconditions hold
- **THEN** resume validation SHALL succeed
- **AND** the normal advance path MAY proceed from the resume target

#### Scenario: Stale candidate SHA refuses resume

- **WHEN** the answered handoff's `candidate_sha` differs from the current PR/worktree head
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance
- **AND** refusal evidence SHALL name the SHA mismatch

#### Scenario: Changed dossier or policy hash refuses resume

- **WHEN** the handoff bound a dossier or policy content hash
- **AND** the current dossier or effective policy hash differs
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance

#### Scenario: Expired answer refuses resume

- **WHEN** `expires_at` is in the past for an answered handoff
- **THEN** status projection SHALL treat the handoff as expired for resume purposes
- **AND** resume validation SHALL fail
- **AND** the item SHALL NOT advance

#### Scenario: Superseded answer refuses resume

- **WHEN** resume is attempted against a handoff whose status is `superseded`
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance

#### Scenario: Ambiguous resume target refuses resume

- **WHEN** `resume_target` is missing, malformed, or maps to more than one conflicting stage entry
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance

---

### Requirement: Operator surfaces SHALL list and inspect handoffs in human-readable and JSON forms

The engine SHALL provide list and show operations filterable by issue, run, repository, and queue batch. Default human-readable output SHALL include handoff id, status, class, authority mode, question summary, age, blocked stage, and resume target. `--json` (or equivalent) SHALL emit machine-readable records. Show SHALL include the full question, reason, eligibility evidence, scope hashes, answer provenance when present, and audit summary.

#### Scenario: List pending by issue

- **WHEN** an operator lists handoffs for issue N with status filter pending
- **THEN** the output SHALL include each pending handoff for that issue
- **AND** SHALL omit handoffs for other issues

#### Scenario: JSON list is machine-readable

- **WHEN** list is invoked with JSON output enabled
- **THEN** the output SHALL be valid JSON representing handoff records
- **AND** each record SHALL include `handoff_id`, `status`, and `handoff_class`

#### Scenario: Show includes exact question and evidence

- **WHEN** show is invoked for handoff H
- **THEN** the output SHALL include the exact `question` text
- **AND** SHALL include candidate SHA, class, authority mode, and eligibility or answer evidence as applicable

---

### Requirement: Malformed, unauthorized, expired, and unresolved routing paths SHALL fail safely and preserve evidence

Unauthorized answers, unidentified actors on authority-bearing handoffs, expired or superseded resume attempts, ambiguous resume targets, and malformed records SHALL fail closed without silent success. Each such path SHALL preserve prior durable state and append or retain evidence of the failure. The engine SHALL NOT delete audit history to recover from failure.

#### Scenario: Malformed record does not advance

- **WHEN** a stored handoff fails schema validation at resume time
- **THEN** resume SHALL be refused
- **AND** workflow labels SHALL be unchanged
- **AND** evidence of the malformation SHALL be available for diagnosis

#### Scenario: Failures are side-effect free for workflow stage

- **WHEN** an unauthorized answer or stale resume is refused
- **THEN** the item's pipeline stage labels SHALL be identical to the pre-attempt state
- **AND** no forward stage transition SHALL occur

### Requirement: Pre-admission Decision nodes SHALL reuse `pipeline handoff answer` with a policy-bound grill-authority gate

Pipeline SHALL represent unresolved pre-admission typed requests (`DecisionRequest`, input-requiring `CapabilityRequest`, and protected `AuthorityRequest`) as human-question handoffs answered through the existing `pipeline handoff answer` surface. It SHALL NOT add a second answer ledger or a new handoff CLI verb. It SHALL NOT create a handoff for a node that auto-settled under existing authority. Create for those typed-request nodes SHALL use a policy-bound authority gate whose evidence is repository, issue, node ID, frontier fingerprint, and source body hash. When no PR or worktree tip exists, create SHALL allow `candidate_sha` to be omitted. This gate SHALL NOT replace or weaken mid-flight human-decision-required evidence that binds a reviewed SHA. Model-written `settled-by` prose and `auto-accept` SHALL NOT satisfy an `AuthorityRequest` that lacks existing authority.

#### Scenario: Create succeeds without a PR tip

- **WHEN** create is requested for a `human-attestation` `AuthorityRequest` on an issue with no PR or worktree tip
- **AND** repository, issue, node ID, frontier fingerprint, and source body hash are present
- **THEN** a pending authority-bearing handoff SHALL be persisted
- **AND** `candidate_sha` MAY be null

#### Scenario: Mid-flight HDR path is unchanged

- **WHEN** create is requested for a mid-flight `product_judgment` handoff with no HDR diagnostic and no policy-bound gate other than grill-authority
- **THEN** create SHALL fail closed as specified by the existing HDR requirement
- **AND** grill-authority evidence SHALL NOT substitute for a reviewed SHA on that mid-flight path

#### Scenario: Reviewer-accept does not answer the handoff

- **WHEN** a pending grill-authority handoff exists for a `scope` node
- **AND** the Decisions artifact records reviewer `accept` or `settled-by: auto-accept` on that node without a matching handoff answer
- **THEN** the handoff status SHALL remain `pending`
- **AND** `--stage ready` SHALL treat the node as unresolved

#### Scenario: Auto-accept does not answer an AuthorityRequest

- **WHEN** a pending grill-authority handoff exists for a protected `scope` node that lacked existing authority
- **AND** the Decisions artifact records `settled-by: auto-accept` on that node without a matching handoff answer
- **THEN** the handoff status SHALL remain `pending`
- **AND** ready validation SHALL treat the node as unresolved

#### Scenario: Covered scope does not create a handoff

- **WHEN** a `scope` recommendation is already covered by existing issue-body authority
- **THEN** grill SHALL NOT create a grill-authority handoff for that node

---

### Requirement: A successful grill-authority answer SHALL materialize into the issue body

When an eligible authenticated actor answers a pending grill-authority handoff, Pipeline SHALL re-fetch the issue body, SHALL require the live full-body SHA-256 to match the handoff binding, and SHALL deterministically patch only that node in the embedded Decisions artifact (resolution, provenance reference, and derived `## Decisions` render). Matching an extracted spec-core hash SHALL NOT authorize a drifted full body. Bound-hash drift SHALL refuse the answer with no body mutation. GitHub comments SHALL NOT perform this materialize. The item SHALL NOT transition to `pipeline:ready` solely because the answer was recorded; `--stage ready` remains a separate deterministic request. After a successful GitHub body write, Pipeline SHALL refresh remaining pending grill-authority handoffs for that issue so each binds the new full-body SHA-256. The answered record SHALL keep the body hash it authorized.

#### Scenario: Matching hash materializes the node

- **WHEN** an eligible actor answers a pending grill-authority handoff
- **AND** the live body hash matches the binding
- **THEN** the matching Decisions node SHALL become resolved with that handoff provenance
- **AND** the rendered `## Decisions` section SHALL match the updated artifact
- **AND** other nodes SHALL be unchanged

#### Scenario: Body drift refuses the answer

- **WHEN** the live body hash differs from the handoff binding
- **THEN** the answer SHALL be refused
- **AND** the issue body SHALL be unchanged
- **AND** handoff status SHALL remain `pending`

#### Scenario: Artifact-only body edit refuses the answer

- **WHEN** the live body SHA-256 differs from the handoff binding because only the Decisions artifact or rendered `## Decisions` section changed
- **THEN** the answer SHALL be refused
- **AND** the issue body SHALL be unchanged
- **AND** handoff status SHALL remain `pending`

#### Scenario: Successful materialize rebinds pending siblings

- **WHEN** a grill-authority answer writes a new issue body
- **THEN** remaining pending grill-authority handoffs for that issue SHALL bind the new body SHA-256
- **AND** the answered handoff SHALL keep the body hash it authorized

#### Scenario: Answer does not flip ready

- **WHEN** a grill-authority answer materializes successfully
- **THEN** Pipeline SHALL NOT add `pipeline:ready` as a side effect of the answer

---

### Requirement: Grill-authority create and answer SHALL use a documented failure order

Grill SHALL create one pending grill-authority handoff per unresolved typed request after settlement classification and before the GitHub body write. Create SHALL bind repository, issue, node ID, frontier fingerprint, and the proposed-body SHA-256. Create SHALL be idempotent on `declaration_identity`. The operator surface SHALL remain `pipeline handoff answer <handoff-id> --issue N --text "…"`. Body-hash drift during answer SHALL leave the GitHub body unchanged and the handoff `pending`. A GitHub body-write failure during materialize SHALL leave the handoff `pending`. Before a GitHub body write, Pipeline SHALL persist a Pipeline-authenticated recovery receipt for the exact expected body. A ledger persist failure after a successful body write SHALL leave the body patched and the handoff `pending`. A later identical answer SHALL heal the ledger without a second body write only when the live node already carries that handoff provenance AND the live full-body SHA-256 matches that receipt. That heal SHALL rebind remaining pending sibling handoffs to the recovered body and SHALL persist the next frontier only after that rebind succeeds. Pipeline SHALL NOT persist a replacement frontier or record the answer when the live body does not match the receipt, including when the target node definition and `handoff:<id>` reference remain.

#### Scenario: Create happens on apply before the body write

- **WHEN** grill classifies unresolved typed requests
- **THEN** one pending handoff SHALL exist per such request before the GitHub body write is attempted
- **AND** auto-settled nodes SHALL NOT have those records

#### Scenario: Create happens on grill before the body write

- **WHEN** grill classifies unresolved typed requests
- **THEN** one pending handoff SHALL exist per such request before the GitHub body write is attempted
- **AND** auto-settled nodes SHALL NOT have those records

#### Scenario: Body-write failure leaves the ledger pending

- **WHEN** answer authorization and body-hash checks pass
- **AND** the GitHub body write then fails
- **THEN** handoff status SHALL remain `pending`
- **AND** the live issue body SHALL be unchanged

#### Scenario: Receipt-matching retry heals without a second write

- **WHEN** a grill-authority answer writes the issue body and then ledger persist fails
- **AND** the live body still matches the recovery receipt
- **THEN** a later identical answer SHALL record the handoff as answered
- **AND** SHALL NOT write the GitHub body a second time

#### Scenario: Receipt-matching retry rebinds pending siblings

- **WHEN** a grill-authority answer writes the issue body
- **AND** pending sibling rebind then fails
- **AND** the live body still matches the recovery receipt
- **THEN** a later identical answer SHALL rebind remaining pending siblings to the recovered body
- **AND** SHALL persist the frontier only after that rebind succeeds
- **AND** SHALL NOT write the GitHub body a second time

#### Scenario: Drift after a partial write refuses heal

- **WHEN** a grill-authority answer writes the issue body and then ledger persist fails
- **AND** an editor then changes the spec core and artifact fingerprint while retaining the target node definition and `handoff:<id>` reference
- **THEN** a later identical answer SHALL be refused
- **AND** the authenticated frontier SHALL be unchanged
- **AND** the handoff SHALL remain `pending`

#### Scenario: Duplicate answer is idempotent

- **WHEN** an eligible actor repeats `pipeline handoff answer` with the same payload hash or `--client-request-id`
- **AND** the handoff is already `answered`
- **THEN** the command SHALL succeed as a duplicate
- **AND** SHALL NOT rewrite the prior answer body
- **AND** SHALL NOT add `pipeline:ready`

### Requirement: The shared CLI positional gate SHALL admit documented `handoff` sub-verb grammar

The shared extra-positionals gate SHALL match the documented `pipeline handoff` grammar so that argv reaches the existing `handoff` dispatch block. The gate SHALL admit `handoff list` with the verb only. The gate SHALL admit `handoff show`, `handoff answer`, `handoff reject`, and `handoff supersede` with the verb plus exactly one handoff ID. Flags such as `--issue` and `--json` SHALL remain options and SHALL NOT count as positional tokens. The operator interface SHALL be the `pipeline handoff <verb>` CLI. Direct module invocation SHALL NOT be an accepted operator path. This requirement SHALL NOT change per-verb required flags, registry allowlists, authentication, idempotency, issue locking, Decisions materialization, or audit behavior. Authenticated handlers SHALL still enforce authentication.

#### Scenario: `handoff list` reaches the list handler

- **WHEN** an operator runs `pipeline handoff list --issue N --json`
- **THEN** the shared extra-positionals gate SHALL NOT reject the `list` verb as an unexpected argument
- **AND** argv SHALL reach the existing list handler

#### Scenario: `handoff show` reaches the read-only handler

- **WHEN** an operator runs `pipeline handoff show <handoff-id> --issue N --json`
- **THEN** the shared extra-positionals gate SHALL NOT reject the `show` verb or the handoff ID as unexpected arguments
- **AND** argv SHALL reach the existing read-only show handler

#### Scenario: Mutating verbs reach authenticated handlers

- **WHEN** an operator runs `pipeline handoff answer <handoff-id> …`, `pipeline handoff reject <handoff-id> …`, or `pipeline handoff supersede <handoff-id> …` with exactly one handoff ID and the existing required flags
- **THEN** the shared extra-positionals gate SHALL NOT reject the verb or the handoff ID as unexpected arguments
- **AND** argv SHALL reach the matching existing authenticated handler
- **AND** that handler SHALL still enforce authentication

#### Scenario: Flags are not positional tokens

- **WHEN** the real argument parser receives `pipeline handoff list --issue N --json`
- **THEN** `--issue` and `--json` SHALL be options
- **AND** the remaining positionals SHALL be `handoff` and `list` only

#### Scenario: CLI-parser regression covers every documented verb

- **WHEN** CLI-level regression tests run each documented handoff verb (`list`, `show`, `answer`, `reject`, `supersede`) through the real argument parser
- **THEN** those tests SHALL fail if the positional gate still rejects the verb
- **AND** handler-only unit tests SHALL NOT be treated as sufficient coverage for this admission gate

#### Scenario: Materialization stays on existing seams

- **WHEN** tests prove that an operator can answer a Decisions authority handoff through the CLI
- **THEN** verification SHALL use the CLI parser plus existing handler and materialization seams with injected I/O
- **AND** verification SHALL NOT require a live GitHub mutation in CI
- **AND** landing this change SHALL NOT itself attest a live Decisions node

#### Scenario: Handler mutation semantics stay unchanged

- **WHEN** admitted `handoff answer`, `handoff reject`, or `handoff supersede` argv reaches its existing handler
- **THEN** that handler SHALL keep current mutation, idempotency, and audit semantics
- **AND** a successful answer SHALL NOT advance the issue as a side effect
- **AND** advance SHALL still stop at `pipeline:ready-to-deploy`
- **AND** merge SHALL remain a separate operator-authorized verb

---

### Requirement: Invalid `handoff` argv SHALL fail with exit 2 before a read or a mutation

The shared extra-positionals gate plus the verb-aware extra-token check SHALL reject invalid `handoff` argv with exit code 2, matching current CLI validation. A missing verb, an unknown verb, or extra positional tokens SHALL fail before dispatch to a handler. Invalid `list` or `show` argv SHALL fail before a read. Invalid `answer`, `reject`, or `supersede` argv SHALL fail before mutation. Extra positional tokens, a missing required ID, a missing verb, and an unknown verb SHALL never reach `answer`, `reject`, or `supersede`. The gate SHALL only admit argv. This requirement SHALL NOT weaken handler authentication.

#### Scenario: Extra tokens after `list` fail before a read

- **WHEN** an operator runs `pipeline handoff list` with an extra positional token
- **THEN** the CLI SHALL exit 2
- **AND** the list handler SHALL NOT run

#### Scenario: ID-taking verbs require exactly one handoff ID

- **WHEN** `show`, `answer`, `reject`, or `supersede` is invoked with no handoff ID
- **THEN** the CLI SHALL exit 2
- **AND** no read SHALL run for `show`
- **AND** no mutation SHALL run for `answer`, `reject`, or `supersede`

#### Scenario: Extra tokens after an ID-taking verb fail before a read or a mutation

- **WHEN** `show`, `answer`, `reject`, or `supersede` is invoked with a handoff ID plus an extra positional token
- **THEN** the CLI SHALL exit 2
- **AND** `show` SHALL NOT read
- **AND** `answer`, `reject`, and `supersede` SHALL NOT mutate

#### Scenario: Missing or unknown verb fails before a handler

- **WHEN** an operator runs `pipeline handoff` with no verb, or with a verb that is not `list`, `show`, `answer`, `reject`, or `supersede`
- **THEN** the CLI SHALL exit 2
- **AND** no list, show, answer, reject, or supersede handler SHALL run

### Requirement: Unblock, override, and answers SHALL resume through the typed-request contract

`pipeline unblock`, `pipeline override`, and `pipeline handoff answer` SHALL fulfill or bind a typed request and SHALL resume only through the existing handoff resume-validation contract. The pipeline SHALL NOT add a second answer ledger or a new resume CLI verb. Resume SHALL revalidate currency (answered status, SHA, bound hashes, expiry, supersession, `resume_target`, and stage preconditions) before any advance that depends on the answer. A failed resume validation SHALL refuse advance, preserve labels and durable state, and record refusal evidence. Kill-switch behavior on unblock and override SHALL remain: no GitHub mutation when the domain kill-switch file is present.

#### Scenario: Unblock uses typed-request resume

- **WHEN** an operator runs `pipeline unblock N "<answer>"` on a blocked issue
- **THEN** the answer SHALL be recorded as typed-request fulfillment
- **AND** any dependent advance SHALL pass handoff resume validation before proceeding
- **AND** the command SHALL NOT only clear `pipeline:blocked` and return without that contract

#### Scenario: Override uses typed-request resume

- **WHEN** an operator runs `pipeline override N "<key>: <reason>"`
- **THEN** the governed disposition SHALL be recorded
- **AND** auto-resume SHALL pass handoff resume validation before re-entering advance
- **AND** the command SHALL NOT invoke a command-local advance that terminalizes the run on the next mechanical fault

#### Scenario: Handoff answer remains the answer surface

- **WHEN** an eligible actor runs `pipeline handoff answer <handoff-id>`
- **THEN** the existing hash-bound answer path SHALL record the fulfillment
- **AND** resume validation SHALL be the same contract used by unblock and override
- **AND** no second answer ledger SHALL be written

#### Scenario: Stale answer still refuses resume

- **WHEN** unblock, override, or handoff answer produces a fulfillment whose candidate SHA no longer matches
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance

### Requirement: Typed-request handoffs SHALL carry the classifier payload

A handoff created for a `DecisionRequest` SHALL include recommendation, rationale, alternatives, risk, and evidence. A handoff created for a `CapabilityRequest` SHALL include the missing capability or information, provider, live probe, and resume condition. A handoff created for an `AuthorityRequest` SHALL include eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry, and SHALL NOT record a default grant. Pipeline SHALL still use `pipeline handoff answer` as the answer surface. Pipeline SHALL NOT add a second answer ledger or a new handoff CLI verb.

#### Scenario: DecisionRequest handoff carries the package

- **WHEN** create runs for an irreducible `DecisionRequest`
- **THEN** the pending handoff SHALL include recommendation, rationale, alternatives, risk, and evidence
- **AND** `authority_mode` SHALL follow existing product-judgment rules without converting the request into an authority grant

#### Scenario: CapabilityRequest handoff names the probe

- **WHEN** create runs for an input-requiring `CapabilityRequest`
- **THEN** the pending handoff SHALL include provider, live probe, and resume condition
- **AND** `authority_mode` SHALL be `non_authority`

#### Scenario: AuthorityRequest handoff never defaults

- **WHEN** create runs for a protected `AuthorityRequest`
- **THEN** the pending handoff SHALL bind eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry
- **AND** SHALL NOT store a default grant

#### Scenario: Incomplete typed node fails closed

- **WHEN** create runs for a typed node that lacks its classifier package or request record
- **THEN** handoff creation SHALL return a validation failure
- **AND** SHALL NOT synthesize missing DecisionRequest, CapabilityRequest, or AuthorityRequest fields

---

### Requirement: Candidate movement SHALL invalidate candidate-bound handoffs and grants

When a handoff or grant is bound to a candidate SHA or candidate epoch and that candidate moves, resume validation SHALL refuse the stale record. Pipeline SHALL re-run the shared classifier against current facts. This requirement SHALL NOT weaken the existing reviewed-SHA gate for mid-flight human-decision-required evidence.

#### Scenario: Moved candidate refuses resume

- **WHEN** an answered handoff is bound to candidate SHA A
- **AND** the current candidate is SHA B
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance on that answer

#### Scenario: Grant bound to old epoch is invalid

- **WHEN** an authority grant is bound to candidate epoch E1
- **AND** the current epoch is E2
- **THEN** that grant SHALL NOT authorize the bound operation
- **AND** a leftover blocked label SHALL NOT restore the grant
