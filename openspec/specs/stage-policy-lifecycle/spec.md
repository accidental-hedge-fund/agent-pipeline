# stage-policy-lifecycle Specification

## Purpose
Define a typed, staged policy lifecycle so Agent Pipeline can roll out policy from draft through observation into enforcement with append-only lineage, deterministic promotion predicates, and readiness invalidation when the effective policy slice changes.

## Requirements

### Requirement: Policy lifecycle states SHALL be a closed typed set

The pipeline SHALL represent each staged policy’s effective state as exactly one of: `draft`, `observe`, `required`, `enforcing`, `retired`. Config parse, load, and transition APIs SHALL reject any other state string. The set of states SHALL be single-sourced and drift-guarded by a unit test.

#### Scenario: Valid state is accepted

- **WHEN** a policy declaration or transition target uses one of `draft`, `observe`, `required`, `enforcing`, or `retired`
- **AND** when the declared or resulting effective state is `enforcing`, a validated lineage entry into `enforcing` is present (see lineage requirement)
- **THEN** validation SHALL accept that state

#### Scenario: Unknown state is rejected

- **WHEN** a policy declaration or transition target uses a string outside the closed set
- **THEN** validation SHALL fail with an error naming the invalid state
- **AND** SHALL NOT treat the unknown string as a default lifecycle state

#### Scenario: Config declaration of enforcing without lineage is rejected

- **WHEN** a staged policy is declared in config with `state: enforcing`
- **AND** no fully validated lineage chain into `enforcing` is present (complete legal path `draft` → `observe` → `required` → `enforcing`, recomputed `policy_hash_before`/`policy_hash_after` matching the acceptance slice, ISO 8601 `at`, non-empty named authority on the enforcing entry, and non-empty `evidence_refs` on observation-gated promotions)
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed with effective state `enforcing`

#### Scenario: Config self-attested single-head enforcing lineage is rejected

- **WHEN** a staged policy is declared in config with `state: enforcing`
- **AND** lineage contains only a self-attested `required` → `enforcing` head (even with non-empty authority strings and non-empty hash strings)
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed with effective state `enforcing`

#### Scenario: Config declaration of required without lineage is rejected

- **WHEN** a staged policy is declared in config with `state: required`
- **AND** no fully validated lineage chain into `required` is present (complete legal path `draft` → `observe` → `required`, recomputed acceptance-slice hashes, ISO 8601 `at`, and non-empty `evidence_refs` on the `observe` → `required` edge)
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed with effective state `required`

#### Scenario: Config declaration of observe without lineage is rejected

- **WHEN** a staged policy is declared in config with `state: observe`
- **AND** no fully validated lineage chain into `observe` is present (legal path `draft` → `observe` with recomputed acceptance-slice hashes and ISO 8601 `at`)
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed with effective state `observe`

#### Scenario: Config declaration of retired without authority lineage is rejected

- **WHEN** a staged policy is declared in config with `state: retired`
- **AND** no lineage event to `retired` with non-empty named authority is present (or hashes/`at` fail materialize validation)
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed with effective state `retired`

---

### Requirement: Lifecycle transitions SHALL be closed and deterministic

The pipeline SHALL allow only the following transitions for staged policies:

- `draft` → `observe`
- `observe` → `required`
- `required` → `enforcing`
- any non-`retired` state → `retired`

All other transitions (including any edge that would enter `enforcing` without traversing the legal path and lineage) SHALL be rejected. Transition evaluation SHALL be a pure function over current state, target state, and promotion/retirement evidence inputs (no network, git, or subprocess in the pure predicate).

#### Scenario: Legal draft to observe

- **WHEN** a policy is in `draft` and a transition to `observe` is requested with valid policy identity
- **THEN** the transition SHALL succeed
- **AND** the effective state SHALL become `observe`

#### Scenario: Illegal jump to enforcing is rejected

- **WHEN** a policy is in `draft` or `observe`
- **AND** a transition directly to `enforcing` is requested
- **THEN** the transition SHALL be rejected
- **AND** the effective state SHALL remain unchanged

#### Scenario: Retired is terminal

- **WHEN** a policy is in `retired`
- **AND** any transition to a non-`retired` state is requested
- **THEN** the transition SHALL be rejected

---

### Requirement: Promotion into enforcing SHALL require evidence and authority

A transition into `enforcing` SHALL succeed only when all of the following hold:

1. Current state is `required`.
2. Observation coverage meets the configured or default minimum (run count and/or coverage window).
3. False-positive or override rate is at or below the configured or default maximum.
4. Unresolved evidence count is at or below the configured or default maximum.
5. A named authority record is present (authenticated actor identity and role/capability sufficient under policy-bound authority rules).

Missing aggregates or missing authority SHALL fail closed for promotion (reject transition). The pipeline SHALL NOT invent observation metrics from harness prose.

#### Scenario: Enforcing promotion with complete evidence

- **WHEN** a policy is in `required`
- **AND** observation coverage, rate bounds, unresolved-evidence bound, and named authority all satisfy thresholds
- **THEN** a transition to `enforcing` SHALL succeed

#### Scenario: Enforcing promotion without authority is rejected

- **WHEN** a policy is in `required`
- **AND** observation metrics meet thresholds
- **AND** no named authority record is supplied
- **THEN** the transition to `enforcing` SHALL be rejected
- **AND** no lineage success event for `enforcing` SHALL be appended

#### Scenario: Enforcing promotion with insufficient observation is rejected

- **WHEN** a policy is in `required`
- **AND** observation coverage is below the minimum
- **THEN** the transition to `enforcing` SHALL be rejected

---

### Requirement: Retirement SHALL require authority and SHALL leave append-only lineage

A transition to `retired` from any non-`retired` state SHALL require a named authority record. On success the pipeline SHALL append a lineage event and SHALL NOT delete prior lineage entries.

#### Scenario: Authorized retirement

- **WHEN** a policy is in `enforcing` (or any other non-`retired` state)
- **AND** a named authority record is present
- **AND** a transition to `retired` is requested
- **THEN** the effective state SHALL become `retired`
- **AND** a lineage event recording from-state, to-state, policy hashes, authority, and timestamp SHALL be appended

#### Scenario: Retirement without authority is rejected

- **WHEN** a transition to `retired` is requested without a named authority record
- **THEN** the transition SHALL be rejected
- **AND** the effective state SHALL remain unchanged

---

### Requirement: Promotion and retirement SHALL create append-only policy lineage

Every successful promotion or retirement SHALL append a lineage record that includes at least: `policy_id`, `from_state`, `to_state`, `policy_hash_before`, `policy_hash_after`, ISO 8601 `at`, `authority`, and `evidence_refs` (array, may be empty only when the transition legally requires no observation aggregates — e.g. `draft`→`observe`). Lineage SHALL be append-only; the pipeline SHALL NOT rewrite or delete prior lineage entries for that policy. An `enforcing` effective state SHALL NOT be reachable without at least one lineage event that records entry into `enforcing`.

#### Scenario: Lineage present for enforcing

- **WHEN** a policy’s effective state is `enforcing`
- **THEN** lineage SHALL contain an event with `to_state: "enforcing"`
- **AND** that event SHALL include non-empty `authority` and the policy hash after the transition

#### Scenario: Static config cannot invent enforcing without lineage

- **WHEN** config load or policy materialization is asked to expose effective state `enforcing`
- **AND** the loaded record lacks a fully validated lineage chain (complete `draft` → `observe` → `required` → `enforcing` path, recomputed acceptance-slice hashes, ISO 8601 `at`, named authority on enforcing, non-empty `evidence_refs` on observation-gated promotions)
- **THEN** load or materialization SHALL fail closed
- **AND** SHALL NOT activate fail-closed readiness gates as if the policy were lawfully enforcing
- **AND** a self-attested single-head `required` → `enforcing` record with arbitrary non-empty strings SHALL NOT satisfy validation

#### Scenario: Lineage is not rewritten on later promotion

- **WHEN** lineage already contains N events for a policy
- **AND** a further legal transition succeeds
- **THEN** lineage length SHALL become N+1
- **AND** the prior N events SHALL remain byte-identical in content

---

### Requirement: Effective state and policy hash SHALL be visible in machine-readable run evidence

When a run evaluates staged policies, the pipeline SHALL record for each in-scope policy at least: `policy_id`, effective `state`, and `policy_hash` in machine-readable run evidence (finalized summary and compatible legacy evidence path). The `policy_hash` SHALL digest the effective acceptance-relevant policy slice for that policy (deterministic canonical inputs).

#### Scenario: Evidence records enforcing policy

- **WHEN** a run finalizes with an in-scope policy in `enforcing`
- **THEN** run evidence SHALL include that policy’s `policy_id`, `state: "enforcing"`, and non-empty `policy_hash`

#### Scenario: Evidence records observe-only policy without claiming enforcement

- **WHEN** a run finalizes with an in-scope policy in `observe`
- **THEN** run evidence SHALL include `state: "observe"`
- **AND** consumers SHALL NOT treat `observe` as equivalent to `enforcing` for fail-closed gates

---

### Requirement: Policy promotion or retirement that changes the acceptance slice SHALL invalidate affected readiness evidence

When a successful transition changes the effective acceptance-relevant policy slice, the pipeline SHALL recompute `policy_hash` for that policy. Readiness consumers SHALL treat prior readiness evidence bound to the previous `policy_hash` as non-current under the shared `evidence_subject` invalidation rules (policy dimension mismatch). The pipeline SHALL NOT leave readiness evidence marked current for the new slice solely because `run_id` or candidate SHA still match.

#### Scenario: Promotion changes policy_hash and invalidates prior readiness

- **WHEN** a policy transitions from `required` to `enforcing` and the acceptance slice changes
- **THEN** `policy_hash_after` SHALL differ from `policy_hash_before`
- **AND** readiness evidence whose subject carries the prior `policy_hash` SHALL compare as policy mismatch / non-current against the new evaluation pin

#### Scenario: Retirement invalidates enforcing-bound readiness

- **WHEN** a policy transitions from `enforcing` to `retired`
- **THEN** a new policy hash (or explicit retired disposition hash) SHALL be recorded
- **AND** readiness composition that depended on the enforcing slice SHALL NOT pass solely on pre-retirement evidence
