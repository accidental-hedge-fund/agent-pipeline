# plan-review-authority-boundary Specification

## Purpose
TBD - created by archiving change docs-distinguish-plan-review-authority. Update Purpose after archive.
## Requirements
### Requirement: Operator surfaces SHALL use a closed authority vocabulary for plan-review

Operator-facing product documentation, host skill guidance, CLI help, status prose, and architecture language that describe `plan-review` SHALL use the following closed vocabulary and SHALL NOT treat these terms as synonyms:

1. **Independent agent plan review** is evidence from the configured secondary reviewer. It is not human approval and is not same-harness fallback evidence.
2. **Human feedback window** is an optional interval in which human comments can steer plan revision. It is not approval.
3. **Human attestation** is provenance or capability evidence. It is not plan sign-off.
4. **Human approval** or **human sign-off** is an affirmative human action that a control requires. It MAY be a direct per-action approval or one authenticated, immutable, expiring factory grant that names the later actions. A grant authorizes only its closed scope; it does not turn plan review into approval.

#### Scenario: Plan-review is described as independent agent review

- **WHEN** operator-facing documentation describes `plan-review` under the cross-harness path
- **THEN** it SHALL describe independent agent review of the implementation plan
- **AND** it SHALL NOT state that plan-review is human sign-off or human approval

#### Scenario: Human feedback window is named separately from approval

- **WHEN** operator-facing documentation describes human comments on the posted plan
- **THEN** it SHALL name an optional human feedback window or equivalent
- **AND** it SHALL NOT equate that window with approval or sign-off

#### Scenario: Attestation, grant, and plan-review remain distinct

- **WHEN** documentation describes Pipeline attestations or a signed scoped factory grant
- **THEN** it SHALL distinguish evidence from the human authorization event
- **AND** it SHALL NOT present agent plan-review evidence as the factory grant
- **AND** it SHALL state that the grant may authorize only the exact later mutations that it names

### Requirement: Operator surfaces SHALL NOT overstate independence on the same-harness plan-review fallback

When the configured plan-review reviewer CLI is missing or unspawnable, shipped engine behavior may fall back to the implementing harness reviewing its own plan and label that output as same-harness self-review. Operator-facing product documentation that describes enabled `plan-review` as independent agent plan review SHALL also distinguish this degraded path: it SHALL state that same-harness self-review is weaker / not independent agent plan review, and SHALL NOT present fallback self-review evidence as equivalent to cross-harness independent agent plan review. High-traffic authority copy (at minimum the README plan-review / human plan feedback section) SHALL name the same-harness fallback when it asserts plan-review independence.

#### Scenario: Authority copy distinguishes independent review from self-review fallback

- **WHEN** operator-facing documentation describes enabled `steps.plan_review` as independent agent plan review
- **THEN** it SHALL also state that when the reviewer CLI is missing or unspawnable, same-harness self-review may produce plan-review evidence instead
- **AND** it SHALL state that labeled same-harness self-review is not independent agent plan review

#### Scenario: Fallback path is not framed as human approval

- **WHEN** documentation describes the same-harness plan-review fallback
- **THEN** it SHALL keep that path as agent self-review evidence
- **AND** it SHALL NOT describe the fallback as human approval or human sign-off

---

### Requirement: Operator surfaces SHALL state feedback-window expiry without human input

Operator-facing documentation of plan-review SHALL state what happens when the human feedback window ends with no human comments: the human feedback list is empty, plan revision proceeds from agent plan-review feedback only (independent agent plan review when the reviewer ran, or labeled same-harness self-review when fallback applied), the pipeline SHALL NOT block solely for missing human input, and the pipeline SHALL NOT treat the absence of human comments as human approval or sign-off.

#### Scenario: No human comments after the plan

- **WHEN** documentation describes a plan-review run in which no eligible human comments are posted before plan revision starts
- **THEN** it SHALL state that revision proceeds using agent plan-review feedback only (independent reviewer or labeled same-harness self-review, as applicable)
- **AND** it SHALL state that missing human comments do not block the advance
- **AND** it SHALL state that missing human comments are not recorded as human approval

#### Scenario: Human comments inside the window remain optional steering

- **WHEN** documentation describes human comments posted after `## Implementation Plan` and before revision
- **THEN** it SHALL describe those comments as optional feedback folded into revision (per `human-plan-feedback`)
- **AND** it SHALL NOT describe them as a required approval gate

---

### Requirement: High-traffic operator copy SHALL NOT equate plan-review with human sign-off

The repository's front-door and packaging surfaces that introduce the lifecycle SHALL NOT claim that `plan-review` is human sign-off or human approval. They SHALL describe plan-review as independent agent review of the plan, with same-harness fallback disclosed when applicable, and an optional human feedback window before implementation. When they describe a scoped factory, they MAY state that a separate signed operator grant supplies human approval for the exact named issue merges and release actions.

#### Scenario: README Lifecycle band uses correct authority language

- **WHEN** a reader opens the README Lifecycle section or equivalent summary
- **THEN** the plan-review text SHALL describe independent agent plan review plus an optional human feedback window
- **AND** it SHALL NOT claim that plan-review is the human sign-off before implementation
- **AND** any scoped grant SHALL be described as a separate authorization event

#### Scenario: Examples show the authority boundary

- **WHEN** README or skill examples describe `steps.plan_review` or the plan-review path
- **THEN** agent plan-review SHALL remain the review evidence when enabled
- **AND** human comments SHALL remain optional steering
- **AND** a direct operator action or a separate valid scoped grant SHALL remain the merge authorization
- **AND** same-harness fallback SHALL NOT be presented as equivalent independent evidence

### Requirement: A drift-guard SHALL fail if plan-review is re-equated with human sign-off

The repository's automated tests covered by `npm run ci` SHALL fail if high-traffic operator copy reintroduces language that equates `plan-review` with human sign-off or human approval without an affirmative human action. The guard SHALL at minimum cover the README Lifecycle (or full `README.md`) forbidden phrases that collapse plan-review into human sign-off, and MAY extend to host packaging surfaces when practical. Explicit negation (for example "plan-review is not human sign-off") SHALL NOT fail the guard.

#### Scenario: Forbidden equality phrase fails the guard

- **WHEN** `README.md` contains a phrase equating plan-review with human sign-off (for example "`plan-review` is the human sign-off before implementation starts")
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: Explicit distinction is allowed

- **WHEN** documentation states that plan-review is independent agent review and is not human sign-off
- **THEN** the drift-guard SHALL NOT fail solely because the words "human sign-off" appear in a negating or distinguishing sentence

#### Scenario: Guard is on the CI path

- **WHEN** `npm run ci` runs the core test suite
- **THEN** the plan-review authority drift-guard SHALL execute as part of that suite

