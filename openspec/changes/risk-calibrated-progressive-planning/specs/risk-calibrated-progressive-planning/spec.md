## Purpose

Evidence-backed progressive-planning policy contract: work and risk classes from observable or declared evidence, closed routing actions with escalation and safe defaults, offline evaluation and calibration before automation, human-authority boundaries for irreversible and sensitive work, and an explicit gate that keeps automated planning-depth routing off until sufficiency criteria are met — without a single opaque risk score or proxy-metric optimization.

## ADDED Requirements

### Requirement: Research note SHALL define candidate work/risk classes from observable or declared evidence

The change SHALL publish a durable research note that defines a closed, versioned set of candidate work/risk classes for progressive planning. Each class SHALL name:

- a stable class id (kebab or snake identifier)
- allowed evidence sources that are either **observable** (structural signals, telemetry joins, labels) or **explicitly declared** (issue body markers, operator annotations, OpenSpec decisions)
- at least one negative example of what does **not** assign the class

Class assignment SHALL NOT require a single numeric risk score spanning all repositories and work types. When evidence is insufficient after allowed sources are checked, the class set SHALL include or resolve to `unknown` rather than inventing a high-confidence class.

#### Scenario: class definitions list evidence sources

- **WHEN** a reader opens the research note
- **THEN** each candidate work/risk class SHALL list at least one allowed observable or declared evidence source
- **AND** SHALL state at least one non-assignment case for that class

#### Scenario: opaque single score is forbidden as the class model

- **WHEN** the research note or policy contract defines how classes are assigned
- **THEN** it SHALL NOT define a single overall risk score field as the sole routing input for all work types
- **AND** multi-label class sets SHALL be allowed when multiple evidence classes match

#### Scenario: insufficient evidence is unknown

- **WHEN** allowed evidence sources for a class are missing or unreadable
- **THEN** assignment for that class SHALL be absent or `unknown`
- **AND** SHALL NOT fabricate historical rework rates or structural matches

#### Scenario: per-class evidence provenance is required for assignment

- **WHEN** a progressive class is asserted for routing composition
- **THEN** it SHALL carry evidence refs with allowed `source_kind` (structural, declared, or historical_observed), a non-empty `ref`, and `observed_as_of` at or before recommendation time
- **AND** outcome-derived, post-routing, or free-text-only source kinds SHALL be rejected without elevating from that class

---

### Requirement: Progressive-planning policy SHALL specify closed routing actions and class-to-action mapping

The policy (research note and this capability) SHALL define a closed set of routing actions that includes at least:

- `lightweight_plan`
- `standard_plan`
- `deepen_product`
- `deepen_technical`
- `zoom_feasibility`
- `zoom_vertical_slice`
- `preserve_assumptions`
- `request_human_authority`

The policy SHALL map work/risk classes and evidence states to one or more of these actions. Composition SHALL use a documented most-restrictive rule when multiple classes match. `preserve_assumptions` SHALL be allowed to stack with depth actions. `request_human_authority` SHALL dominate when its criteria fire.

#### Scenario: closed action vocabulary

- **WHEN** a policy consumer resolves a routing recommendation
- **THEN** the primary action id SHALL be one of the closed action set
- **AND** free-form action strings outside the set SHALL be rejected by validation when a machine-readable recommendation is produced

#### Scenario: most-restrictive composition

- **WHEN** both a lightweight-favoring class and a security_compliance class match
- **THEN** the composed recommendation SHALL NOT be `lightweight_plan` alone
- **AND** SHALL prefer the more restrictive action required by security_compliance (deepen, zoom, or `request_human_authority` per the mapping table)

#### Scenario: preserve_assumptions stacks

- **WHEN** routing selects `lightweight_plan` and open assumptions exist
- **THEN** the recommendation SHALL also include `preserve_assumptions`
- **AND** SHALL NOT drop open assumptions because planning depth is light

---

### Requirement: Escalation boundaries and safe defaults SHALL cover missing and conflicting evidence

The policy SHALL document escalation boundaries and safe defaults for:

- no matching signals
- conflicting signals
- unavailable historical rework or production outcome data
- matched irreversible, high-blast-radius, security-sensitive, or compliance-sensitive classes with incomplete sub-signals

Safe defaults SHALL NOT route irreversible / high-blast / security / compliance classes to `lightweight_plan` solely because historical data is missing. Conflicting signals SHALL prefer the more restrictive action and record a conflict diagnostic when recommendations are machine-readable.

#### Scenario: unknown structural history defaults away from silent under-planning

- **WHEN** no historical rework rates are available and no high-severity class matched
- **AND** the high-severity predicate scan is complete
- **THEN** the default action SHALL be at least `standard_plan` (not forced `lightweight_plan` solely for missing history)

#### Scenario: incomplete high-severity scan does not ordinary-standard

- **WHEN** progressive composition runs with high-severity predicate scan incomplete
- **AND** no progressive classes were matched
- **THEN** the recommendation SHALL NOT select ordinary `standard_plan` via `unknown_default`
- **AND** SHALL fail closed toward deeper planning or human authority as documented

#### Scenario: observed rework history respects pre-routing provenance

- **WHEN** `observed_rework_cost` claims history is available
- **THEN** cohort inputs SHALL exclude the target run and any work completed at or after recommendation time
- **AND** invalid or missing provenance SHALL prevent history-based elevation

#### Scenario: security class with missing sub-signal fails closed

- **WHEN** a security_compliance (or equivalent) class matches and required sub-signals are incomplete
- **THEN** the policy default SHALL be `request_human_authority` or `deepen_technical` plus `preserve_assumptions` as documented
- **AND** SHALL NOT default to `lightweight_plan`

#### Scenario: conflicting signals choose restrictive side

- **WHEN** a declared low-risk signal conflicts with an observed auth/public-api structural signal
- **THEN** the composed action SHALL follow the more restrictive mapping
- **AND** a conflict diagnostic SHALL be recordable

#### Scenario: structured safety conflicts fail closed

- **WHEN** declared and structural evidence conflict on rollback, security, compliance, or blast_radius
- **THEN** composition SHALL apply the elevating safety floor for that dimension
- **AND** SHALL NOT select ordinary `standard_plan` or `lightweight_plan` as the resolved primary action for that conflict set

---

### Requirement: Offline evaluation design SHALL compare planning investment to primary outcomes without proxy-only optimization

The change SHALL publish an offline evaluation design that:

- joins selected `planning_depth` and `risk_class` (from planning-leverage telemetry) to first-pass acceptance, review effort, fix rounds, material rework, and post-merge production/rework outcomes when evidence exists
- preserves observed vs inferred attribution authority from outcome-linkage
- defines false-positive (over-planning) and false-negative (under-planning) in operational terms
- includes a calibration procedure (hold-out or time-window re-evaluation)
- forbids treating plan length, planning wall time alone, or token spend alone as success metrics

Causal impact claims SHALL NOT be required for the research package. Associational rates used for routing calibration SHALL be computed within comparable pre-routing strata (class multi-label set, repository/domain context, and documented size bands when available) so that planning investment is not confounded with inherent task severity. Unmatched pooled depth×rework associations SHALL NOT alone justify retaining or changing action floors.

#### Scenario: primary outcomes are listed

- **WHEN** a reader opens the offline evaluation design
- **THEN** it SHALL list first-pass acceptance, review effort, fix rounds, material rework, and post-merge outcomes as evaluation dimensions
- **AND** SHALL describe the join keys to #702 and #576 records

#### Scenario: proxy-only success is forbidden

- **WHEN** an evaluation report claims progressive-planning success
- **THEN** it SHALL NOT base that claim solely on longer plans, longer planning wall time, or higher token spend
- **AND** at least one primary outcome dimension SHALL be reported

#### Scenario: FP and FN are defined

- **WHEN** calibration analysis runs
- **THEN** false-positive over-planning and false-negative under-planning SHALL each have an operational definition in the design
- **AND** rates SHALL be reportable per class or cohort when sample size allows

#### Scenario: missing production join does not invent outcomes

- **WHEN** a run has planning-leverage telemetry but no production_outcome attribution
- **THEN** offline eval SHALL omit production outcome metrics for that run or mark them unavailable
- **AND** SHALL NOT fabricate outcome ids

#### Scenario: offline progressive classes come from pre-routing sources

- **WHEN** offline evaluation builds pre-routing strata for progressive multi-label classes without observe-mode emissions
- **THEN** class sets SHALL be taken from immutable pre-routing snapshots when present, or from blinded retrospective coding of planning-time structural/declared evidence only
- **AND** SHALL NOT use the target run’s material rework, review findings, or production outcomes as class evidence

#### Scenario: post-merge outcomes use time-at-risk censoring

- **WHEN** offline eval reports post-merge production or rework rates
- **THEN** it SHALL apply a fixed observation horizon H (default 14 days) from merge or deploy anchor
- **AND** runs with `eval_as_of` before merge_at + H SHALL be labeled not-yet-observable or unavailable, not as negative (no incident) outcomes

---

### Requirement: Human-authority boundaries SHALL be explicit and distinct from agent plan-review

The policy SHALL define closed human-authority boundaries covering at least irreversible changes, high blast radius, security-sensitive work, and compliance-sensitive work. Agent plan-review (including same-harness fallback) and the optional human feedback window SHALL NOT count as human authority for those boundaries.

#### Scenario: irreversible work requires human authority floor

- **WHEN** the matched class set indicates irreversible production or data mutation without a documented automated rollback path
- **THEN** the routing action SHALL include `request_human_authority`
- **AND** agent plan-review approval alone SHALL NOT satisfy the human-authority boundary

#### Scenario: plan-review is not human authority

- **WHEN** plan-review returns approve with no human sign-off event
- **THEN** human-authority boundaries for security/compliance/irreversible classes SHALL remain unsatisfied
- **AND** the policy SHALL NOT treat plan-review as the human authority action

#### Scenario: high blast radius has operational criteria beyond multi-tenant wording

- **WHEN** a change is a public API or wire-format break with external consumers, or a default-traffic deploy/infra change (pipeline/CDN/auth-gateway cutover or forced all-tenant rollout), or a multi-repo cutover without a staged rollout plan
- **THEN** the high-blast-radius human-authority predicate MAY fire even without multi-tenant language
- **AND** a single private-module rename with no external consumers SHALL NOT set that predicate solely by path count

#### Scenario: ordinary production delivery is not high blast by deploy criterion

- **WHEN** a change is an ordinary application release through an existing CI/CD path with no deploy-pipeline, CDN, auth-gateway, or default-traffic path change and no forced all-tenant rollout
- **THEN** the default-traffic deploy sub-criterion of high_blast_radius SHALL NOT set solely from that ordinary delivery
- **AND** a documented staged or canary plan without default-path cutover SHALL NOT set that sub-criterion alone

---

### Requirement: Automated planning-depth routing SHALL remain disabled until evidence sufficiency is recorded

Automated selection or override of run `planning_depth` by progressive-planning policy SHALL NOT be enabled by this research change. Any future automation SHALL be represented as a staged policy that remains in a non-enforcing state (`draft` or `observe`) until an evidence-sufficiency checklist referencing planning-leverage (#702) and production-outcome (#576) windows is satisfied and recorded as promotion evidence. Config SHALL NOT introduce an always-on auto-routing switch that bypasses staged-policy lineage.

#### Scenario: research change does not enable automation

- **WHEN** this change is implemented and merged
- **THEN** the advance/planning path SHALL continue without progressive-planning auto-selection of `planning_depth`
- **AND** no new config key SHALL force `enforcing` progressive-planning routing by default

#### Scenario: promotion requires evidence refs

- **WHEN** a future change proposes progressive-planning policy state `enforcing`
- **THEN** promotion lineage SHALL include non-empty evidence references to offline evaluation or observe-window results
- **AND** validation SHALL reject `enforcing` without that lineage (via stage-policy-lifecycle rules)

---

### Requirement: Recommended planning depth mapping SHALL stay within the existing depth vocabulary

When the policy maps routing actions to a recommended `planning_depth`, the recommendation SHALL use only `minimal`, `standard`, `deep`, or `unknown` (the planning-leverage closed set). Sub-actions such as `deepen_product` vs `deepen_technical` MAY be recorded as separate action ids without inventing new depth enum values in this research change.

#### Scenario: depth recommendation uses closed enum

- **WHEN** a machine-readable recommendation includes `recommended_planning_depth`
- **THEN** its value SHALL be one of `minimal`, `standard`, `deep`, `unknown`
- **AND** SHALL NOT introduce free-form depth strings

#### Scenario: sub-action does not require new depth enum

- **WHEN** routing selects `deepen_product`
- **THEN** `recommended_planning_depth` MAY be `deep`
- **AND** the distinct product-vs-technical intent SHALL remain in the action id field
