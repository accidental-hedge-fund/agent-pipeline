## Purpose

Govern finding and scoped overrides with a versioned class taxonomy, policy-bound authenticated authority, required evidence, expiry, renewal-lite, supersession lineage, subject-bound invalidation, and append-only decision history so only currently valid overrides can unblock a run.

## ADDED Requirements

### Requirement: Override governance config SHALL define a versioned class taxonomy and per-class policy

The pipeline SHALL accept an optional versioned override-governance configuration that defines a closed set of override class identifiers and, for each class, at least: authorized-actor resolution rules (identity, group reference, role, and/or continuity with the trusted-override-actors allowlist), required evidence reference kinds, maximum duration, separation-of-duty rules when enabled, and renewal mode (`lite`, `human`, or `none`) with a closed set of human-required drift events. Unknown class identifiers, unknown keys, invalid durations, and invalid renewal modes SHALL fail at configuration parse time. The pipeline SHALL NOT silently ignore unknown classes or policy fields.

#### Scenario: valid class taxonomy parses

- **WHEN** repository config defines `override_governance` with `schema_version: 1` and known classes each carrying max duration, approver rules, required evidence list, and renewal mode
- **THEN** configuration resolution SHALL accept the block
- **AND** expose each class policy for override evaluation

#### Scenario: unknown class id in config fails parse

- **WHEN** configuration references a class policy key that is not in the declared taxonomy, or nests an unknown field under a class
- **THEN** configuration resolution SHALL fail with a parse error naming the unknown class or field
- **AND** the pipeline SHALL NOT run with a partial governance config

#### Scenario: invalid max duration fails parse

- **WHEN** a class sets `max_duration_hours` to zero, a negative number, or a non-integer
- **THEN** configuration resolution SHALL fail at parse time

#### Scenario: invalid renewal mode fails parse

- **WHEN** a class sets renewal mode to a value other than `lite`, `human`, or `none`
- **THEN** configuration resolution SHALL fail at parse time

---

### Requirement: Recording an override SHALL resolve authenticated authority and enforce class policy

When an operator records a key or scoped override, the engine SHALL authenticate the actor, resolve authorization against the target class policy, enforce required evidence and remediation references for that class, enforce separation of duties when enabled, bind an engine-built evidence subject, capture finding fingerprint and code region (or scope identity), assign `created_at` and `expires_at` within the class maximum duration, and append a decision record. An unidentified actor, unauthorized actor, SoD violation, missing required evidence, unknown class, empty explanation, or malformed target SHALL be refused: no decision record SHALL be posted as active, and the invocation SHALL fail closed with a typed reason.

#### Scenario: authorized record succeeds with full decision fields

- **WHEN** an authenticated actor authorized for class `high_risk_accept` supplies the class, a valid target, non-empty explanation, and all required evidence references
- **THEN** the engine SHALL append a decision record carrying actor, identity source, authorization resolution, class, target, explanation, evidence and remediation refs, evidence subject, fingerprint/region, `created_at`, `expires_at`, and a new `decision_id`
- **AND** the record’s lifecycle SHALL be `active`

#### Scenario: unauthorized actor is refused

- **WHEN** an authenticated actor who does not match any approver rule for the requested class attempts an override
- **THEN** the engine SHALL refuse the record
- **AND** SHALL NOT post an active override sentinel that unblocks the finding
- **AND** SHALL emit a machine-readable rejection or unauthorized outcome

#### Scenario: missing required evidence is refused

- **WHEN** class policy requires a remediation issue URL and the invocation omits it
- **THEN** the engine SHALL refuse the record
- **AND** the finding SHALL remain blocking

#### Scenario: separation of duties blocks self-disposition

- **WHEN** class SoD is enabled and forbids the implementer role
- **AND** the only matching actor is classified as implementer for the item
- **THEN** the engine SHALL refuse the override
- **AND** SHALL NOT unblock the finding

#### Scenario: unknown class on CLI is refused

- **WHEN** an operator names a class id that is not in the effective taxonomy
- **THEN** the engine SHALL fail with a usage or validation error before posting
- **AND** SHALL NOT create a decision record

---

### Requirement: Only currently valid active overrides SHALL unblock findings

A finding or scope SHALL be excluded from the blocking set only when there exists a decision whose target matches, whose lifecycle projection is `active`, whose authorization remains valid under current policy, whose evidence subject compares as current against the evaluation pin on governed dimensions, and whose `expires_at` is not in the past (unless a concurrent renewal-lite or human renewal has produced a new active successor). Unauthorized, expired, malformed, scope-mismatched, superseded, renewed (predecessor), rejected, or invalidated decisions SHALL NOT unblock a run.

#### Scenario: active valid override excludes finding from blocking set

- **WHEN** an active decision for finding key `a1b2c3d4` passes validity evaluation against the current pin
- **AND** exactly one live finding resolves to that key
- **THEN** that finding SHALL be treated as overridden and SHALL NOT block

#### Scenario: expired decision does not unblock

- **WHEN** a decision’s `expires_at` is in the past
- **AND** no renewal produced a new active successor
- **THEN** validity evaluation SHALL classify the decision as `expired`
- **AND** the matching finding SHALL remain in the blocking set

#### Scenario: scope-mismatched decision does not unblock

- **WHEN** a decision targets scope `file:src/a.ts`
- **AND** the live finding’s file is outside that scope
- **THEN** the decision SHALL NOT disposition that finding

#### Scenario: unauthorized residual after policy change does not unblock

- **WHEN** an earlier active decision’s actor would no longer authorize under the current effective class policy
- **THEN** validity evaluation SHALL not treat the decision as `active` for unblock
- **AND** the finding SHALL block until a new authorized decision is recorded

---

### Requirement: Evidence subject and ownership drift SHALL invalidate overrides

When the evaluation pin’s evidence subject mismatches a decision’s bound subject on candidate, policy, ownership-relevant, affected-component, or verifier dimensions that govern override currency, the engine SHALL classify the decision as `invalidated` (or non-active) and SHALL NOT use it to unblock. Invalidation SHALL append an event or projection update that preserves the original record; it SHALL NOT rewrite the original decision’s fields in place.

#### Scenario: candidate SHA change invalidates prior override

- **WHEN** a decision was recorded for candidate SHA A
- **AND** the evaluation pin advances to candidate SHA B where A ≠ B
- **THEN** validity evaluation SHALL report the decision non-active for unblock
- **AND** diagnostics SHALL name candidate (or subject) mismatch

#### Scenario: policy hash change invalidates policy-bound override

- **WHEN** two subjects differ only in `policy_hash`
- **THEN** a policy-bound override decision SHALL be non-current for readiness unblock under the new policy
- **AND** the original decision record SHALL remain readable with its original content

#### Scenario: verifier fingerprint change invalidates

- **WHEN** the evaluation pin’s `verifier_fingerprint` differs from the decision’s subject
- **THEN** the decision SHALL NOT remain active for unblock solely on key match

---

### Requirement: History SHALL be append-only with supersession and renewal lineage

The engine SHALL preserve every recorded decision. A later decision for the same target MAY supersede a prior active decision by appending a new record that references the prior `decision_id`; the prior record’s `expires_at` and body SHALL remain unchanged. A renewal SHALL append a new decision linked via `renewed_from` (or equivalent lineage field) and SHALL NOT mutate the prior decision’s expiry. Silent in-place rewrite of class, actor, evidence, or expiry SHALL NOT occur.

#### Scenario: supersession creates a new record

- **WHEN** an authorized actor records a new decision for a target that already has an active decision
- **THEN** the engine SHALL append a new `decision_id`
- **AND** SHALL mark or project the prior decision as `superseded`
- **AND** SHALL leave the prior record’s original `expires_at` unchanged

#### Scenario: renewal does not mutate prior expiry

- **WHEN** a human or lite renewal succeeds for decision D1 producing D2
- **THEN** D2 SHALL reference D1 in its renewal lineage
- **AND** D1’s stored `expires_at` SHALL remain the value recorded at D1 creation
- **AND** only D2’s new `expires_at` governs continued active unblock

#### Scenario: repeated overrides remain in the ledger

- **WHEN** three successive authorized decisions are recorded for the same key
- **THEN** all three decision records SHALL remain queryable in history
- **AND** only the latest currently valid decision SHALL be active for unblock

---

### Requirement: Renewal-lite SHALL auto-renew only when fingerprint and code region are unchanged

When class renewal mode is `lite`, and wall-clock reaches expiry (or a scheduled revalidation runs), the engine SHALL append an auto-renew decision if and only if the live finding fingerprint and code region (or scope identity) still match the prior decision and the evidence subject remains current on governed dimensions and the prior authorization would still hold under current policy. Auto-renew SHALL NOT require a new human click and SHALL NOT invent a new authorized actor. If any configured drift event applies (fingerprint drift, region drift, subject mismatch, policy change when listed), auto-renew SHALL NOT run; the prior decision SHALL expire or invalidate and the finding SHALL block until a human renewal or fix.

#### Scenario: unchanged fingerprint auto-renews

- **WHEN** class renewal mode is `lite`
- **AND** the live finding fingerprint and code region match the prior decision
- **AND** the evidence subject still matches the evaluation pin on governed dimensions
- **AND** prior authorization still holds
- **THEN** the engine SHALL append a renewal decision with new `expires_at` and lineage to the prior decision
- **AND** the finding SHALL remain dispositioned without a new human action

#### Scenario: fingerprint drift requires human

- **WHEN** class renewal mode is `lite`
- **AND** the live finding fingerprint differs from the prior decision
- **THEN** the engine SHALL NOT auto-renew
- **AND** the finding SHALL return to the blocking set until a human records a new authorized decision

#### Scenario: human renewal mode never auto-renews

- **WHEN** class renewal mode is `human`
- **AND** `expires_at` is in the past
- **THEN** the engine SHALL classify the decision as `expired`
- **AND** SHALL NOT append a lite renewal
- **AND** only an authorized human renewal or superseding decision MAY restore active status

#### Scenario: renewal mode none forbids renewal link

- **WHEN** class renewal mode is `none`
- **AND** the decision has expired
- **THEN** a new decision MAY be recorded as a fresh supersession
- **AND** the engine SHALL NOT treat it as a renewal of the expired decision’s authority window without a new full authorization pass

---

### Requirement: Lifecycle states and events SHALL be machine-readable

Run evidence and event streams SHALL distinguish at least: `active`, `expired`, `superseded`, `renewed`, `rejected`, and `invalidated` for override decisions. Events SHALL carry fields sufficient for age, recurrence, class, authority, renewal lineage, and downstream outcome analysis (including correlation identifiers for later outcome linkage consumers). Rejected record attempts and invalidated actives SHALL be visible in evidence, not silent.

#### Scenario: evidence lists lifecycle states

- **WHEN** a run has one active, one expired, and one superseded decision
- **THEN** the evidence bundle or equivalent run evidence SHALL present each with its lifecycle state
- **AND** consumers SHALL be able to filter by state without parsing free-text reasons

#### Scenario: renewal event is machine-readable

- **WHEN** a lite or human renewal is appended
- **THEN** an event SHALL name the renewal kind, class, actor (or system for lite), prior `decision_id`, new `decision_id`, and timestamps

#### Scenario: invalidation event names reason

- **WHEN** a decision is invalidated by subject drift
- **THEN** an event SHALL record lifecycle `invalidated` and a closed invalidation reason
- **AND** SHALL reference the decision id and mismatched subject dimensions when known

---

### Requirement: Compatibility path SHALL map legacy free-form dispositions without elevating authority

When override governance config is omitted, the engine SHALL apply an implicit low-risk compatibility class that preserves non-empty free-form reason dispositions for key and scope targets under the existing trusted-actor model, while still applying subject binding, append-only recording, and renewal-lite where applicable. When config is present, bare free-form reasons SHALL map only to the configured default class if set; otherwise the operator MUST name a class. Compatibility SHALL NOT silently grant high-risk class authority or skip required evidence for high-risk classes.

#### Scenario: omitted config preserves low-risk disposition ability

- **WHEN** `override_governance` is absent from config
- **AND** an authenticated trusted actor records `--override "a1b2c3d4: deferred — tracked offline"`
- **THEN** the engine SHALL accept the disposition under the implicit low-risk class
- **AND** SHALL still record decision metadata needed for expiry and renewal-lite

#### Scenario: configured default class maps bare reasons

- **WHEN** config sets `default_class: low_risk_deferred`
- **AND** the operator supplies a bare key and reason without a class token
- **THEN** the engine SHALL apply `low_risk_deferred` policy
- **AND** SHALL NOT apply a higher-risk class

#### Scenario: high-risk class still requires its evidence under migration

- **WHEN** an operator requests class `high_risk_accept` without required evidence refs
- **THEN** the engine SHALL refuse the record even if free-form reasons were previously accepted without evidence

#### Scenario: legacy sentinel without class remains low-risk only

- **WHEN** extractors read a pre-governance `pipeline-override` sentinel without class or decision id
- **THEN** the projection SHALL treat it as the compatibility low-risk class
- **AND** SHALL NOT treat it as satisfying a high-risk class policy
