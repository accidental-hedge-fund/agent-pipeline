## Purpose

Define versioned repository-control desired state, live-state comparison through existing `gh` read surfaces, structured drift outcomes with freshness and fail-open/fail-closed risk classes, and a read-only check surface — without mutating forge settings or inventing a second ForgeAdapter.

## ADDED Requirements

### Requirement: Desired-state snapshot SHALL be versioned and cover the control families in scope

The pipeline SHALL define a versioned `repository_control_desired_state` object with integer `schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `schema_version` — integer, value `1` for this revision
- `repository` — repository identity string (owner/name or pipeline domain form)
- `default_branch` — branch name whose protections/checks are in scope (or equivalent protected-branch field)
- `required_checks` — list of check context names that MUST be required
- `branch_protections` — expected branch-protection fields that are readable through the active `gh`/API read path
- `rulesets` — expected ruleset identifiers/names and enforcement expectations when ruleset reads are in scope
- `required_pipeline_gates` — Agent Pipeline evidence/gate identifiers required for readiness composition when configured
- `collector_requirements` — collector/version constraints when configured (empty/absent when not used)
- optional binding fields: `policy_id`, per-control or section `risk_class` in the closed set `observation` | `fail_open` | `fail_closed`

Config load SHALL reject unknown `schema_version` values for hard enforcement paths and SHALL reject unknown `risk_class` strings. Readers SHALL ignore unknown fields on snapshots they do not need to enforce.

#### Scenario: schema_version 1 carries required families

- **WHEN** a desired-state snapshot with `schema_version: 1` is validated
- **THEN** it SHALL include `repository`, `default_branch`, `required_checks`, `branch_protections`, `rulesets`, `required_pipeline_gates`, and `collector_requirements` (the latter MAY be empty)

#### Scenario: Unknown risk_class is rejected

- **WHEN** a desired-state declaration sets `risk_class` to a value outside `observation` | `fail_open` | `fail_closed`
- **THEN** config or snapshot validation SHALL fail
- **AND** SHALL NOT default the control to `fail_closed` silently

---

### Requirement: Live state SHALL be read only through existing gh surfaces without mutation

The pipeline SHALL obtain live repository-control state using injectable wrappers over existing `gh` CLI/API read operations (the same class of surfaces used for PR checks and repository metadata). The compare and check paths SHALL NOT create, update, or delete branch protection rules, rulesets, required checks, labels, or other forge settings. The pipeline SHALL NOT introduce a second ForgeAdapter interface in this capability; unsupported control kinds SHALL degrade via structured outcomes rather than a new adapter abstraction.

#### Scenario: Check path performs no forge writes

- **WHEN** a repository-control drift check runs against a configured desired state
- **THEN** the path SHALL issue only read operations through the injectable `gh` seam
- **AND** SHALL NOT call forge mutation APIs for protection, rulesets, or required checks

#### Scenario: No ForgeAdapter type required for v1

- **WHEN** implementation of live readers is inspected against this capability
- **THEN** it SHALL use existing `gh` read helpers / injectable deps
- **AND** SHALL NOT require a new `ForgeAdapter` interface to complete compare

---

### Requirement: Compare SHALL emit a closed outcome set with field-level differences and freshness

Comparing desired state to a live snapshot SHALL return a structured result whose top-level `outcome` is exactly one of: `in_sync`, `drifted`, `unknown`, `unsupported`, `unavailable`. Results SHALL include at least: repository identity, policy identity when bound (`policy_id` or null), live snapshot reference or payload digest, ISO 8601 timestamp of the compare (and live `fetched_at`), field-level differences when `drifted` (each with path, desired, live), freshness flag, and evidence-subject identity when a candidate run exists (or an explicit standalone-check disposition when no candidate exists).

Outcome rules:

- `in_sync` — live is well-formed, fresh, and equal to desired under documented equality rules for each control family
- `drifted` — live is well-formed and fresh enough to compare, and at least one field differs
- `unknown` — payload is partial or mapping is ambiguous so equality cannot be decided
- `unsupported` — the control family cannot be read on this engine path / forge capability is absent
- `unavailable` — auth, permission, network, rate limit, or similar prevented a live read

A live snapshot older than the configured maximum age SHALL NOT be reported as `in_sync`; the compare SHALL re-fetch when possible or emit `unavailable` or `unknown` with `stale: true`.

#### Scenario: Matching fresh live state is in_sync

- **WHEN** desired required checks and readable branch protections equal the live snapshot
- **AND** the live snapshot is within the freshness window
- **THEN** outcome SHALL be `in_sync`
- **AND** field-level differences SHALL be empty

#### Scenario: Required-check name missing live is drifted

- **WHEN** desired `required_checks` includes context `CI`
- **AND** the live required-check set does not include `CI`
- **AND** the live snapshot is fresh and well-formed
- **THEN** outcome SHALL be `drifted`
- **AND** field-level differences SHALL include a path identifying the missing required check

#### Scenario: Branch or ruleset protection mismatch is drifted

- **WHEN** desired branch-protection or ruleset fields differ from the live readable values
- **AND** the live snapshot is fresh and well-formed
- **THEN** outcome SHALL be `drifted`
- **AND** field-level differences SHALL name the mismatched paths

#### Scenario: Stale live state is not in_sync

- **WHEN** a cached live snapshot is older than the maximum age
- **AND** no fresh re-fetch is available
- **THEN** outcome SHALL NOT be `in_sync`
- **AND** the result SHALL mark the snapshot stale

#### Scenario: Missing permissions yield unavailable

- **WHEN** the `gh` read for branch protection or rulesets fails due to insufficient permissions
- **THEN** outcome SHALL be `unavailable`
- **AND** SHALL NOT be `in_sync` or silent skip

#### Scenario: Unsupported control family yields unsupported

- **WHEN** a desired-state section requires a control family that the current `gh` read path cannot represent
- **THEN** outcome for that family SHALL be `unsupported`
- **AND** SHALL NOT be treated as `in_sync`

---

### Requirement: Fail-open and fail-closed behavior SHALL be explicit by risk class and lifecycle state

Blocking behavior SHALL depend on both the control `risk_class` and the bound policy lifecycle state when a policy is bound:

- `draft` or `observe` — record drift only; SHALL NOT block readiness for that control
- `required` — record drift; MAY block only when config explicitly enables gating at `required`
- `enforcing` + `observation` risk class — record only; SHALL NOT block readiness
- `enforcing` + `fail_open` — record + advisory diagnostic; readiness MAY proceed
- `enforcing` + `fail_closed` — on `drifted`, `unavailable`, or `unknown`, readiness SHALL NOT pass for that control; the engine SHALL park or refuse with a typed reason code

Unbound controls (no policy_id) SHALL use the snapshot section’s `risk_class` alone with the same fail-open/fail-closed meaning for check-command severity, and SHALL NOT invent an `enforcing` state.

#### Scenario: Observe policy drift does not block readiness

- **WHEN** a bound policy is in `observe`
- **AND** compare outcome is `drifted`
- **THEN** the pipeline SHALL record the drift result in evidence
- **AND** SHALL NOT fail readiness solely due to that drift

#### Scenario: Enforcing fail-closed drift blocks readiness

- **WHEN** a bound policy is in `enforcing`
- **AND** the control `risk_class` is `fail_closed`
- **AND** compare outcome is `drifted`
- **THEN** readiness for that control SHALL NOT pass
- **AND** a typed drift reason code SHALL be recorded

#### Scenario: Enforcing fail-open drift does not hard-block

- **WHEN** a bound policy is in `enforcing`
- **AND** the control `risk_class` is `fail_open`
- **AND** compare outcome is `drifted`
- **THEN** the pipeline SHALL record an advisory diagnostic
- **AND** SHALL NOT treat the drift alone as a hard readiness failure

#### Scenario: Unavailable on fail-closed enforcing is not in_sync pass

- **WHEN** a bound policy is in `enforcing` with `risk_class: fail_closed`
- **AND** compare outcome is `unavailable`
- **THEN** the control SHALL NOT contribute an `in_sync` pass
- **AND** readiness SHALL NOT pass for that control

---

### Requirement: Drift results SHALL carry repository, policy, live snapshot, timestamp, and evidence-subject identity

Every emitted drift result (run evidence or check-command output) SHALL include:

- repository identity
- policy identity (`policy_id` or null)
- live snapshot reference or digest
- compare timestamp and live `fetched_at`
- `outcome` and field-level differences
- `evidence_subject` when produced in a candidate run context

When produced by a standalone read-only check without a product candidate, the result SHALL set an explicit standalone disposition and SHALL NOT claim multi-family readiness pass.

#### Scenario: Run-scoped drift binds evidence_subject

- **WHEN** drift compare runs during a pipeline run with a known candidate SHA
- **THEN** the drift result SHALL include a well-formed `evidence_subject` (or nested subject fields) derived from runtime state
- **AND** SHALL include repository and policy identity fields

#### Scenario: Standalone check does not invent readiness pass

- **WHEN** an operator runs the read-only drift check outside a candidate advance
- **THEN** the result SHALL still report outcome, diffs, and freshness
- **AND** SHALL NOT claim readiness composition success for the repository

---

### Requirement: A read-only check command or doctor surface SHALL report drift

The pipeline SHALL expose a read-only operator surface (CLI command and/or doctor static check) that loads configured desired state, fetches live state through injectable `gh` reads, runs compare, and prints human-readable and optional machine-readable (`--json`) results. The surface SHALL declare non-mutation (`mutatesGitHub: false` when registered). Default exit policy: non-zero when any fail-closed enforcing control is not `in_sync`; optional strict mode MAY non-zero on any `drifted`.

#### Scenario: JSON check output includes outcomes

- **WHEN** the operator invokes the read-only check with JSON output and desired state is configured
- **THEN** stdout SHALL include structured results with `outcome` values from the closed set
- **AND** the process SHALL NOT mutate forge settings

#### Scenario: Absent desired state is a no-op pass for the gate

- **WHEN** no repository-control desired state is configured
- **THEN** the check surface SHALL report that drift checking is not configured
- **AND** SHALL NOT invent a desired state from live forge defaults

---

### Requirement: Automatic remediation of drift SHALL NOT be performed

On any non-`in_sync` outcome the pipeline SHALL record evidence and apply fail-open/fail-closed readiness rules only. The pipeline SHALL NOT automatically recreate rulesets, rewrite branch protection, force-add required checks, or otherwise remediate live forge configuration as part of this capability.

#### Scenario: Drifted required checks do not auto-repair

- **WHEN** compare outcome is `drifted` on required checks
- **THEN** the pipeline SHALL NOT call APIs that add or remove required status checks
- **AND** SHALL leave remediation to a human or an externally authorized system outside this capability

---

### Requirement: Unit tests SHALL cover lifecycle-adjacent drift outcomes with injectable deps

Unit tests for this capability SHALL cover at least: required-check drift; branch/ruleset drift; missing permissions → `unavailable`; stale live state not `in_sync`; unsupported control family; fail-closed vs fail-open readiness disposition; no mutation on check. Tests SHALL inject `gh`/time/config fakes and SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Permission failure test locks unavailable

- **WHEN** the live-reader fake returns a permission error
- **THEN** the unit test suite SHALL assert outcome `unavailable` and assert readiness does not pass for fail-closed enforcing controls

#### Scenario: Unsupported family test locks unsupported

- **WHEN** the desired state includes a control family the reader marks unsupported
- **THEN** the unit test suite SHALL assert outcome `unsupported` and SHALL NOT assert `in_sync`
