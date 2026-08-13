# pre-code-attestation Specification

## Purpose
TBD - created by archiving change require-human-attestation-for-high-risk. Update Purpose after archive.
## Requirements
### Requirement: The pre_code_attestation config block SHALL be opt-in and strictly validated

`PartialConfigSchema` SHALL accept an optional strict `pre_code_attestation` object with at least:

- `enabled` (boolean, default `false`)
- `triggers` (array of built-in risk class names; default the documented full built-in set)
- `extra_triggers` (optional map of trigger class name → additional path or label globs)
- `thresholds` (optional object with nullable numeric pre-code size/blast-radius fields such as `max_files` and `max_loc`)
- `expiration` (object with `max_age_hours` integer ≥ 1 and `reapprove_on` array of closed invalidation event names)
- `approvers` (array of ordered resolution rules; each rule has a closed `kind` and kind-specific fields)
- `separation_of_duties` (object with `enabled` boolean default `false` and optional `forbid_self_attest_roles` array)
- `wait` (object with `mode` of `resume_safe` | `hard_block`, default `resume_safe`, and optional `max_wait_hours`)

Unknown keys inside `pre_code_attestation` SHALL be rejected at config-parse time. When the block is absent, `cfg.pre_code_attestation.enabled` SHALL be `false` and no pre-code attestation gate behavior SHALL run.

#### Scenario: pre_code_attestation absent — gate disabled by default

- **WHEN** `.github/pipeline.yml` contains no `pre_code_attestation` block
- **THEN** `resolveConfig()` SHALL set `cfg.pre_code_attestation.enabled` to `false`
- **AND** the remaining `pre_code_attestation` fields SHALL take their documented defaults

#### Scenario: enabled with a trigger subset

- **WHEN** `.github/pipeline.yml` sets `pre_code_attestation: { enabled: true, triggers: ["auth", "storage"] }`
- **THEN** `cfg.pre_code_attestation.enabled` SHALL be `true`
- **AND** `cfg.pre_code_attestation.triggers` SHALL be exactly `["auth", "storage"]`

#### Scenario: unknown key inside pre_code_attestation is rejected

- **WHEN** `.github/pipeline.yml` sets `pre_code_attestation: { enabled: true, silent_approve: true }`
- **THEN** `resolveConfig()` SHALL throw a strict-schema parse error identifying `silent_approve` as an unknown key
- **AND** the pipeline SHALL NOT run

#### Scenario: invalid wait mode is rejected

- **WHEN** `.github/pipeline.yml` sets `pre_code_attestation.wait.mode` to a value other than `resume_safe` or `hard_block`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the invalid mode

---

### Requirement: Trigger evaluation SHALL be deterministic, pure, pre-implementation, and recorded

The pipeline SHALL expose `evaluatePreCodeAttestationTrigger(inputs)` returning
`{ triggered: boolean, matched: TriggerMatch[], reason: string }`, where inputs include issue labels,
repository-owned deterministic issue-metadata rules, and the proposed plan/dossier surface (declared
paths, components, risk classes, size estimates). The function SHALL perform no network, git, or
subprocess calls and SHALL return identical output for identical input.

Built-in risk classes SHALL include at least `architecture`, `auth`, `storage`, `migration`,
`public-api`, and `large-diff`. Each `TriggerMatch` SHALL name the trigger class and the concrete
evidence that matched. When the gate does not fire, `reason` SHALL be one of `gate-disabled` or
`no-trigger-matched`. The result SHALL be recorded on the pre-code attestation stage record on every
run that reaches the gate position, whether or not the gate fires.

#### Scenario: gate disabled — recorded skip, no human hold

- **WHEN** the `pre-code-attestation` stage runs with `cfg.pre_code_attestation.enabled` set to `false`
- **THEN** the stage SHALL advance toward `implementing` without requiring human attestation
- **AND** the stage record SHALL carry `triggered: false` with reason `gate-disabled`

#### Scenario: enabled but no trigger matches — recorded skip

- **WHEN** the gate is enabled and no label, plan/dossier path, component, risk class, or size threshold matches an armed trigger
- **THEN** the stage SHALL advance toward `implementing` without requiring a dossier or human attestation
- **AND** the stage record SHALL carry `triggered: false` with reason `no-trigger-matched`

#### Scenario: a trigger matches before implementation

- **WHEN** the gate is enabled with the `auth` class and the plan/dossier declares affected paths or components matching that class
- **THEN** `evaluatePreCodeAttestationTrigger` SHALL return `triggered: true`
- **AND** `matched` SHALL contain an `auth` entry naming the matching evidence
- **AND** the evaluation SHALL occur before the `implementing` stage begins product code changes

#### Scenario: evaluation is pure and repeatable

- **WHEN** `evaluatePreCodeAttestationTrigger` is called twice with identical inputs
- **THEN** it SHALL return deeply equal results
- **AND** it SHALL make no network, git, or subprocess call

---

### Requirement: Triggered work SHALL NOT enter implementing without valid human attestation

When trigger evaluation returns `triggered: true`, the pipeline SHALL NOT transition the issue into
`implementing` until a current, affirmative attestation record exists for the exact dossier revision
under the effective attestation policy. Agent plan-review approval, pipeline output markers alone,
model prose claiming approval, or an unauthenticated click SHALL NOT satisfy the gate.

#### Scenario: triggered without attestation holds implementing

- **WHEN** the gate is triggered and no current approve attestation exists for the current dossier revision and policy hash
- **THEN** the issue SHALL NOT enter `implementing`
- **AND** the engine SHALL record a typed wait or integrity outcome with evidence

#### Scenario: plan-review agent approve is insufficient

- **WHEN** plan-review returns an agent approval and the pre-code gate is triggered
- **AND** no authorized human attestation record exists
- **THEN** the issue SHALL NOT enter `implementing` solely because of the agent plan-review result

#### Scenario: valid approve advances to implementing

- **WHEN** the gate is triggered and a current attestation with `decision: approve` passes authorization, SoD, expiry, and dossier/policy currency checks
- **THEN** the issue MAY advance to `implementing`
- **AND** the attestation record SHALL be present in the evidence bundle

---

### Requirement: Authorized approver resolution SHALL be deterministic and policy-bound

The engine SHALL resolve authorized approvers from repository-owned policy rules and authenticated
identity using a pure resolution function over injectable identity/ownership inputs. Rule kinds
SHALL include at least `identity`, `group_ref`, `role`, `path_owner`, and risk-class scope filters.
Resolution SHALL prove that the actor is authorized for every affected component and matched risk
class under the effective policy revision. Merely recording that a human clicked approve without
authorization resolution SHALL be insufficient. CODEOWNERS or GitHub teams MAY supply inputs through
adapters but SHALL NOT be required.

#### Scenario: identity-authorized actor is accepted

- **WHEN** policy includes an `identity` rule for actor `alice` covering the matched risk classes and affected paths
- **AND** the authenticated actor is `alice`
- **THEN** authorization resolution SHALL succeed for those obligations
- **AND** the attestation record SHALL cite the matching rule and resolution evidence

#### Scenario: unauthorized actor is rejected

- **WHEN** the authenticated actor is not covered by any rule for at least one affected (component, risk class) obligation
- **THEN** authorization resolution SHALL fail
- **AND** the gate SHALL NOT treat the submission as an approve
- **AND** evidence SHALL record the unauthorized attempt

#### Scenario: unresolved ownership fails closed

- **WHEN** triggered scope includes an affected path or component for which no approver rule yields any authorized actor
- **THEN** the gate SHALL fail closed with a typed unresolved-ownership outcome
- **AND** the issue SHALL NOT enter `implementing`

#### Scenario: provider-specific inputs are optional

- **WHEN** the repository has no CODEOWNERS file and no GitHub-team group adapter configured
- **AND** policy uses only `identity` rules that cover the scope
- **THEN** resolution SHALL succeed without requiring CODEOWNERS or teams

---

### Requirement: Separation of duties SHALL block prohibited self-attestation when enabled

When `separation_of_duties.enabled` is `true`, the engine SHALL refuse an attestation if the
authenticated actor holds a role listed in `forbid_self_attest_roles` for the item (including
implementer or dossier author when so configured). When separation of duties is disabled, an
otherwise authorized actor MAY self-attest.

#### Scenario: SoD blocks implementer self-attest

- **WHEN** separation of duties is enabled with `forbid_self_attest_roles` including `implementer`
- **AND** the authenticated actor is attributed as the implementer for the item
- **THEN** the attestation SHALL be rejected as a separation-of-duty failure
- **AND** the issue SHALL NOT enter `implementing`

#### Scenario: SoD disabled allows authorized self-attest

- **WHEN** separation of duties is disabled
- **AND** the authenticated actor is authorized by policy and is also the dossier author
- **THEN** the engine SHALL NOT reject solely for self-attestation
- **AND** other authorization and currency checks SHALL still apply

---

### Requirement: Attestation records SHALL bind actor, authority, dossier, and policy

An attestation record SHALL include at least: actor, authenticated identity source, authorization
rule identifiers and resolution evidence, timestamp, scope (components, risk classes, objective IDs),
decision (`approve` | `reject`), exact dossier revision or content hash reviewed, and effective
attestation-policy configuration revision or hash. Approve records SHALL also carry `expires_at`
derived from policy. Reject decisions SHALL fail closed, preserve evidence, and SHALL NOT advance to
`implementing`.

#### Scenario: approve record fields are complete

- **WHEN** an authorized actor approves a triggered dossier
- **THEN** the stored attestation SHALL include actor, identity source, authorization resolution evidence, timestamp, scope, decision `approve`, dossier hash/revision, policy hash/revision, and `expires_at`

#### Scenario: reject does not advance

- **WHEN** an authorized actor rejects the dossier
- **THEN** the issue SHALL NOT enter `implementing`
- **AND** the reject record SHALL be preserved in run evidence

---

### Requirement: Material change after approval SHALL invalidate attestation

A material change to the dossier content hash/revision, implementation scope, affected component/risk classification, ownership mapping used for resolution, identity authorization rules, or effective policy hash SHALL mark the prior attestation non-current and return the item to the pre-code attestation gate. Expired attestations SHALL likewise be non-current.

#### Scenario: dossier hash change invalidates approve

- **WHEN** an approve attestation exists for dossier hash H1
- **AND** the dossier is revised to hash H2
- **THEN** the H1 attestation SHALL be non-current
- **AND** the issue SHALL NOT enter `implementing` until a new current approve exists for H2

#### Scenario: policy hash change invalidates approve

- **WHEN** an approve attestation was bound to policy hash P1
- **AND** the effective attestation policy hash becomes P2
- **THEN** the prior attestation SHALL be non-current
- **AND** the gate SHALL require re-approval under P2

#### Scenario: expired attestation is non-current

- **WHEN** the current time is after the attestation `expires_at`
- **THEN** the attestation SHALL be non-current
- **AND** the issue SHALL NOT enter `implementing` on that attestation

---

### Requirement: Wait and integrity outcomes SHALL use typed escalation without silent bypass

Rejection, unauthorized approval, unresolved ownership, separation-of-duty failure, and configuration-error paths SHALL fail closed and preserve evidence. Waiting for an authorized human SHALL use the durable wait/human-input surfaces with a typed request rather than inventing a new unrecoverable park class. When `wait.mode` is `resume_safe` (default), wait-budget exhaustion SHALL remain operator-visible and resume-safe and SHALL NOT silently approve. When `wait.mode` is `hard_block`, wait-budget exhaustion MAY hard-block under the typed escalation inventory. No configuration SHALL permit silent approval or bypass once a trigger has fired.

#### Scenario: unauthorized path fails closed

- **WHEN** an unauthenticated or unauthorized actor submits an approve
- **THEN** the engine SHALL reject the approve
- **AND** SHALL NOT enter `implementing`
- **AND** SHALL preserve evidence of the attempt

#### Scenario: waiting for human uses durable hold

- **WHEN** the gate is triggered and no attestation has been submitted yet
- **THEN** the engine SHALL place a typed human-input wait or equivalent durable hold naming the attestation decision needed
- **AND** SHALL NOT invent a new permanent park class solely named for this wait

#### Scenario: resume_safe wait exhaustion does not silent-approve

- **WHEN** `wait.mode` is `resume_safe` and the wait budget is exhausted without an approve
- **THEN** the engine SHALL NOT treat the item as approved
- **AND** SHALL NOT enter `implementing` without a valid attestation

#### Scenario: no silent bypass config

- **WHEN** a repository attempts to configure automatic approval without an authorized human actor
- **THEN** strict schema validation SHALL reject the configuration or the runtime SHALL fail closed without approving

---

### Requirement: Run evidence SHALL record gate evaluation and authorization outcomes

For every run that reaches the pre-code attestation position, evidence SHALL record the effective
configuration digest or material fields, trigger evaluation result, approver-resolution result when
triggered, and why the gate fired or remained inert. Integrity failures and wait states SHALL leave
durable evidence suitable for later audit.

#### Scenario: inert gate records reason

- **WHEN** the gate is disabled or untriggered
- **THEN** the evidence bundle SHALL include the skip reason (`gate-disabled` or `no-trigger-matched`)

#### Scenario: triggered authorize path records resolution

- **WHEN** an approve is accepted
- **THEN** the evidence bundle SHALL include trigger matches, authorization resolution evidence, dossier hash, and policy hash
)

