# plan-review-authority-boundary Specification

## Purpose
TBD - created by archiving change docs-distinguish-plan-review-authority. Update Purpose after archive.
## Requirements
### Requirement: Operator surfaces SHALL use a closed authority vocabulary for plan-review

Operator-facing product documentation, host skill guidance, CLI help, status prose, and architecture language that describe the `plan-review` stage SHALL use the following closed vocabulary and SHALL NOT treat any two of these terms as synonyms:

1. **Independent agent plan review** — the secondary/reviewer harness (or configured reviewer) successfully reviews the posted implementation plan and produces plan-review evidence (for example a `## Plan Review` comment with a structured verdict). This is agent evidence, not human approval. The term applies only when the configured reviewer actually ran; it does **not** apply to same-harness self-review fallback evidence.
2. **Human feedback window** — the interval after the `## Implementation Plan` comment is posted during which non-pipeline human comments are eligible to be collected for plan revision. Human comments are optional steering, not a required control.
3. **Human attestation** — verifiable pipeline output markers (for example `pipeline-attest` / review-artifact body hashes) or operator capability attestations (for example loop/native-goal attestation config). Attestation is provenance or capability evidence, not plan sign-off.
4. **Human approval** (also called **human sign-off**) — an affirmative human action that a control actually requires before proceeding (for example human merge at `ready-to-deploy`, a `needs-human` disposition, or a shipped graduated-autonomy approval checkpoint). Plan-review SHALL NOT be described as human approval unless an affirmative human action is actually required for that control.

#### Scenario: Plan-review is described as independent agent review

- **WHEN** operator-facing documentation describes the `plan-review` stage under the designed cross-harness path
- **THEN** it SHALL describe that stage as independent agent plan review (cross-harness or configured reviewer) of the implementation plan
- **AND** it SHALL NOT state that plan-review is human sign-off or human approval

#### Scenario: Human feedback window is named separately from approval

- **WHEN** operator-facing documentation describes human comments on the posted plan
- **THEN** it SHALL name that opportunity as a human feedback window (or equivalent phrasing that means optional feedback)
- **AND** it SHALL NOT equate that window with human approval or sign-off

#### Scenario: Attestation and approval remain distinct from plan-review

- **WHEN** documentation describes pipeline output attestation markers or operator capability attestation
- **THEN** it SHALL use attestation language
- **AND** it SHALL NOT present those controls as plan-review human sign-off
- **AND** human merge at `ready-to-deploy` (or other true human-approval controls) SHALL remain named as human approval / human-owned merge, not as plan-review

---

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

The repository's front-door and packaging surfaces that introduce the lifecycle (at minimum `README.md`, and host skill lifecycle/architecture language when they assert plan-review authority) SHALL NOT claim that `plan-review` is human sign-off or human approval. When those surfaces need a one-line lifecycle summary, they SHALL describe plan-review as independent agent review of the plan (with same-harness self-review disclosed when the reviewer CLI is missing) with an optional human feedback window before implementation.

#### Scenario: README Lifecycle band uses correct authority language

- **WHEN** a reader opens the README Lifecycle section (or equivalent front-door band table)
- **THEN** the plan-review row or sentence SHALL describe independent agent plan review plus an optional human feedback window
- **AND** that surface SHALL NOT contain a claim that plan-review is the human sign-off before implementation
- **AND** when the surface asserts independence, it SHALL not omit the same-harness fallback qualification (or a clear pointer to where that qualification is stated)

#### Scenario: Examples show the authority boundary

- **WHEN** README or skill examples describe `steps.plan_review` or the plan → review → revise → implement path
- **THEN** the example SHALL show that agent plan-review is the review control when enabled
- **AND** human comments are optional steering inside the feedback window
- **AND** human merge remains a separate terminal human-approval control at `ready-to-deploy`
- **AND** when independence is asserted, same-harness self-review fallback SHALL NOT be presented as equivalent independent evidence

---

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

