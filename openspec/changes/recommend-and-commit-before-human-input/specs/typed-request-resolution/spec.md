## Purpose

Shared recommend-and-commit law that separates product decisions, missing information, unavailable capability, and protected authority before Pipeline asks a human.

## ADDED Requirements

### Requirement: The public typed-request union SHALL contain exactly three members

The public typed-request union SHALL contain exactly `DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest`. Required information SHALL be a `CapabilityRequest` reason. Pipeline SHALL NOT add a fourth public request type. Durable-pause kinds `decision`, `answer`, and `authority-grant` SHALL map onto that union as compatibility aliases: `decision` to `DecisionRequest`, `answer` to `CapabilityRequest`, and `authority-grant` to `AuthorityRequest`. A product `DecisionRequest` SHALL NOT be treated as an `AuthorityRequest` because a compatibility label currently conflates them.

#### Scenario: Required information is a CapabilityRequest

- **WHEN** progress needs information that is not in repository, issue, forge, runtime, or policy evidence
- **THEN** Pipeline SHALL emit a `CapabilityRequest`
- **AND** SHALL NOT emit a fourth request type for that missing information

#### Scenario: Product decision is not authority

- **WHEN** a waiting record uses compatibility kind `decision`
- **THEN** Pipeline SHALL project it as a `DecisionRequest`
- **AND** SHALL NOT treat it as an `AuthorityRequest` or `missing-authority` solely because of that kind string

#### Scenario: Authority-grant alias stays AuthorityRequest

- **WHEN** a waiting record uses compatibility kind `authority-grant`
- **THEN** Pipeline SHALL project it as an `AuthorityRequest`
- **AND** SHALL still require the AuthorityRequest binding fields

---

### Requirement: Pipeline SHALL gather evidence and commit a recommendation before any human ask

Pipeline SHALL gather repository, issue, forge, runtime, and policy evidence before it creates a `DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest`. Models SHALL NOT ask an operator for a fact those sources already provide. Pipeline SHALL record a recommendation, rationale, alternatives, risk, and evidence for every classified decision. Low model confidence alone SHALL NOT change the request class and SHALL NOT create a typed request.

#### Scenario: Discoverable fact is not a typed request

- **WHEN** a frontier question can be answered from the repository tree, issue body, forge state, runtime observation, or policy
- **THEN** Pipeline SHALL record that fact and the recommendation
- **AND** SHALL NOT create a typed request for that fact

#### Scenario: Low confidence does not manufacture a human ask

- **WHEN** the model marks low confidence on a recommendation that meets the auto-settle predicate
- **THEN** Pipeline SHALL auto-settle that recommendation
- **AND** SHALL NOT create a `DecisionRequest` or `AuthorityRequest` for confidence alone

---

### Requirement: A recommended default SHALL auto-settle only under the existing-authority predicate

Pipeline SHALL auto-settle a recommendation only when it is reversible, in current scope, policy-consistent, already authorized by trusted facts, and not contradicted by authoritative evidence. Pipeline SHALL derive those predicates from trusted taxonomy, repository, GitHub, runtime, and configuration facts. Model-written coverage fields SHALL NOT satisfy the predicate. Pipeline SHALL fail closed when coverage cannot be proven. Auto-settle SHALL NOT grant merge, release, deploy, secret, override, destructive, or other protected authority.

#### Scenario: Reversible architectural choice auto-settles

- **WHEN** the recommendation is a reversible in-scope architectural choice
- **AND** trusted facts prove policy consistency and existing authority
- **AND** no authoritative evidence contradicts it
- **THEN** Pipeline SHALL record the node as resolved with `settled-by: auto-accept`
- **AND** SHALL NOT create a handoff or human hold

#### Scenario: Contradictory requirements do not auto-settle

- **WHEN** two acceptance criteria cannot both be true
- **THEN** Pipeline SHALL emit a `DecisionRequest`
- **AND** SHALL NOT auto-settle either side

#### Scenario: Unproven coverage fails closed

- **WHEN** trusted facts do not prove existing authority for the concrete recommendation
- **THEN** Pipeline SHALL NOT auto-settle
- **AND** SHALL classify a typed request from the remaining evidence

---

### Requirement: DecisionRequest records SHALL carry the resolution package

A `DecisionRequest` and every newly written decision resolution SHALL record recommendation, rationale, alternatives, risk, and evidence. A newly written resolution that omits any of those fields SHALL fail closed. Pipeline SHALL NOT treat comments as the resolution record.

#### Scenario: Complete DecisionRequest validates

- **WHEN** Pipeline emits a `DecisionRequest` with recommendation, rationale, alternatives, risk, and evidence
- **THEN** validation SHALL succeed
- **AND** the issue-body Decisions node SHALL carry those fields

#### Scenario: Missing rationale fails closed

- **WHEN** a newly written decision resolution omits rationale
- **THEN** Pipeline SHALL refuse to persist that resolution
- **AND** SHALL NOT auto-settle or park from the incomplete record

---

### Requirement: CapabilityRequest records SHALL name capability, provider, live probe, and resume condition

A `CapabilityRequest` SHALL name the missing capability or information, the provider, the exact live probe, and the resume condition. A condition that can become true without supplied input SHALL be an external-condition wait, not a human `CapabilityRequest`. A `CapabilityRequest` SHALL request restoration or input. It SHALL NOT request approval, merge, release, deploy, or override authority.

#### Scenario: Missing credential becomes CapabilityRequest

- **WHEN** progress requires an unavailable credential and the live probe names that credential check
- **THEN** Pipeline SHALL emit a `CapabilityRequest` that names the credential, provider, live probe, and resume condition
- **AND** SHALL NOT emit an `AuthorityRequest` for that missing credential

#### Scenario: External condition waits without a human ask

- **WHEN** an external condition is currently false and can become true without supplied input
- **THEN** Pipeline SHALL enter an external-condition wait
- **AND** SHALL NOT create a `CapabilityRequest` that asks a human to supply that condition

#### Scenario: Incomplete CapabilityRequest fails closed

- **WHEN** a `CapabilityRequest` omits the live probe or resume condition
- **THEN** Pipeline SHALL refuse to persist that request
- **AND** SHALL NOT park the item as human authority

---

### Requirement: AuthorityRequest records SHALL bind actor, repository, operation, scope, candidate epoch, evidence, and expiry

An `AuthorityRequest` SHALL bind eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry. An `AuthorityRequest` SHALL never record a default grant. Product decisions SHALL NOT become `AuthorityRequest` solely because a compatibility label or `specification-decision` class exists. Auto-settle and model prose SHALL NOT invent merge, release, deploy, secret, or override authority.

#### Scenario: Protected merge without authority is AuthorityRequest

- **WHEN** a recommendation would merge and trusted facts do not prove existing merge authority
- **THEN** Pipeline SHALL emit an `AuthorityRequest` bound to actor, repository, merge operation, scope, candidate epoch, evidence, and expiry
- **AND** SHALL NOT auto-settle that recommendation

#### Scenario: AuthorityRequest never defaults

- **WHEN** an `AuthorityRequest` is created
- **THEN** Pipeline SHALL leave the grant unset
- **AND** SHALL require an authenticated eligible actor to answer through the existing handoff surface

#### Scenario: Incomplete AuthorityRequest fails closed

- **WHEN** create omits eligible actor, candidate epoch while a tip exists, or expiry
- **THEN** Pipeline SHALL refuse to persist the `AuthorityRequest`
- **AND** SHALL NOT invent an assignee or a default grant

#### Scenario: Diagnostic without proven bindings is not AuthorityRequest

- **WHEN** a diagnostic carries category `authority` but does not prove eligible actor, operation, scope, evidence, or expiry
- **THEN** Pipeline SHALL NOT emit an `AuthorityRequest`
- **AND** SHALL NOT substitute generic actor, operation, scope, evidence, or expiry values

---

### Requirement: Candidate movement SHALL invalidate candidate-bound requests and grants

When the candidate SHA or candidate epoch changes, Pipeline SHALL invalidate candidate-bound `DecisionRequest`, `CapabilityRequest`, `AuthorityRequest`, and authority grants bound to the prior epoch. Resume SHALL re-run the shared classifier against current facts. A leftover stage label SHALL NOT preserve the stale request or grant.

#### Scenario: New HEAD invalidates a bound AuthorityRequest

- **WHEN** a pending `AuthorityRequest` is bound to candidate SHA A
- **AND** the current candidate becomes SHA B
- **THEN** that request and any grant bound to SHA A SHALL be invalid
- **AND** Pipeline SHALL NOT resume on the stale answer

#### Scenario: Stale blocked label is not a grant

- **WHEN** candidate movement invalidates a bound request
- **AND** the issue still carries `pipeline:blocked`
- **THEN** that label SHALL NOT preserve the prior authority
- **AND** the classifier SHALL run again on current facts

---

### Requirement: Unknown errors, stale labels, and retry exhaustion SHALL NOT manufacture human authority

Unknown errors, low confidence alone, stale labels, and retry exhaustion SHALL NOT create a `DecisionRequest`, an `AuthorityRequest`, or a human-authority disposition. Those faults SHALL remain engine-owned recovery, Cooling, or an external-condition wait unless independent current typed-request evidence exists.

#### Scenario: Unknown error is not AuthorityRequest

- **WHEN** a stage fails with an unknown error shape and no current typed-request evidence exists
- **THEN** Pipeline SHALL keep the outcome engine-owned
- **AND** SHALL NOT emit an `AuthorityRequest` or `DecisionRequest` solely for that error

#### Scenario: Retry exhaustion is not missing-authority

- **WHEN** recovery retry budget is exhausted for a mechanical class
- **THEN** Pipeline SHALL enter Cooling or an external-condition wait
- **AND** SHALL NOT record `missing-authority` or `specification-decision` solely for that exhaustion

#### Scenario: Stale needs-human label is not authority

- **WHEN** an issue carries a leftover `pipeline:needs-human` or `pipeline:blocked` label without current typed-request evidence
- **THEN** Pipeline SHALL NOT treat that label as a `DecisionRequest` or `AuthorityRequest`

---

### Requirement: Grill, advance, recovery, and ship SHALL share one classifier

Grill, advance, recovery, and ship SHALL classify recommend-and-commit outcomes through one shared classifier. A site SHALL NOT park a human ask, `specification-decision`, or `missing-authority` without that classifier. The next identical false-human fault SHALL be caught by the classifier tests rather than a new path-local issue.

#### Scenario: Recovery uses the same auto-settle rule as grill

- **WHEN** a mid-flight reversible in-scope recommendation meets the auto-settle predicate
- **THEN** recovery SHALL auto-settle it
- **AND** SHALL NOT park `specification-decision` for that recommendation

#### Scenario: Site cannot bypass the classifier

- **WHEN** a call site attempts to record `human_authority` or create a typed request
- **THEN** that outcome SHALL be the classifier result
- **AND** a unit or seam test SHALL fail if a production site parks without the classifier

---

### Requirement: Classifier tests SHALL distinguish the five locked cases

Unit tests for the shared classifier SHALL inject facts and I/O seams. No unit test SHALL perform a real network, git, or subprocess call. The suite SHALL distinguish reversible architectural choice, contradictory requirements, missing information, unavailable capability, and missing protected authority.

#### Scenario: Five cases resolve to five outcomes

- **WHEN** the classifier suite runs the five locked fixtures
- **THEN** reversible architectural choice SHALL auto-settle
- **AND** contradictory requirements SHALL be a `DecisionRequest`
- **AND** missing information SHALL be a `CapabilityRequest`
- **AND** unavailable capability that needs input SHALL be a `CapabilityRequest`
- **AND** missing protected authority SHALL be an `AuthorityRequest`

#### Scenario: External-condition wait stays distinct from CapabilityRequest

- **WHEN** the unavailable-capability fixture uses a condition that can become true without supplied input
- **THEN** the outcome SHALL be an external-condition wait
- **AND** SHALL NOT be a human `CapabilityRequest`
