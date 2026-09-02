# stage-output-contract Specification

## Purpose
TBD - created by archiving change universal-stage-output-contract. Update Purpose after archive.

## Requirements

### Requirement: Implementer-facing stages SHALL declare versioned machine-checkable output contracts

The pipeline SHALL provide a central stage-output-contract layer under `core/scripts/` that
registers a versioned output contract for every in-scope implementer-facing stage (and every
structured-output reviewer stage) whose advance path depends on a machine-checkable harness
output shape. Each contract SHALL declare a stable id including a version (for example
`plan-revision.ack@1`), a kind among a closed set that includes at least `markdown-sections`,
`json-schema`, and `filesystem-shape`, a pure `validate` function over the product output (stdout
and/or filesystem snapshot after any adapter envelope normalization), and the stage side effect
that MUST NOT run until validation succeeds.

At minimum the registry SHALL include:

- `plan-revision.ack@1` — `## Feedback Incorporated` acknowledgement section contract
- `openspec.change-singular@1` — exactly one new (or single fallback) OpenSpec change directory
- `review.verdict@1` — structured review verdict JSON schema sourced from the existing
  `review-schema.ts` constant (not a forked copy)

#### Scenario: Minimum contracts are registered

- **WHEN** the stage-output-contract registry is inspected at runtime or by unit test
- **THEN** it SHALL contain versioned entries for plan-revision acknowledgement, OpenSpec change
  singularity, and review verdict
- **AND** each entry SHALL expose a pure validate function and a versioned id

#### Scenario: Missing in-scope registration fails a drift guard

- **WHEN** an in-scope contract id required by this capability is removed from the registry
- **THEN** a co-located unit test SHALL fail

#### Scenario: Contract version is part of the id

- **WHEN** a registered contract is read
- **THEN** its id SHALL include an explicit version component
- **AND** a breaking change to the machine-checkable shape SHALL require a new version rather
  than silently altering the prior id's acceptance criteria without a version bump

---

### Requirement: Central validation SHALL run before stage side effects

For every registered contract, the owning stage path SHALL invoke the central validation entry
(directly or via the shared format-repair helper) and SHALL NOT perform the gated side effect
when validation returns not-ok. Gated side effects include at least: posting a revised plan
comment, accepting a review verdict for severity/policy advancement, and advancing past OpenSpec
authoring when the singularity contract fails.

#### Scenario: Failed plan-revision ack does not post the plan

- **WHEN** plan-revision stdout fails `plan-revision.ack@1` after repair budget exhaustion
- **THEN** the pipeline SHALL NOT post the revised plan as an issue comment
- **AND** SHALL surface a contract failure rather than advancing as if acknowledgement succeeded

#### Scenario: OpenSpec multi-change does not advance on failed singularity

- **WHEN** OpenSpec authoring produces more than one new change directory
- **AND** `openspec.change-singular@1` validation fails after the shared repair policy is applied
- **THEN** the stage SHALL block without treating the multi-change tree as the single expected
  change for downstream implement

#### Scenario: Unparseable review verdict is not treated as empty product findings

- **WHEN** reviewer stdout cannot be parsed into a schema-satisfying verdict under
  `review.verdict@1` after repair budget exhaustion
- **THEN** the failure SHALL be classified as an output-contract failure
- **AND** SHALL NOT be recorded as a successful verdict that merely carries zero findings

---

### Requirement: A single shared format-repair policy SHALL own bounded shape retries

The pipeline SHALL implement exactly one shared format-repair policy used by registered
contracts that declare repair as applicable. The default budget SHALL be one automatic
re-prompt (two verification attempts total: original plus one repair). The repair invocation
SHALL append a short format-repair addendum derived from the contract (and MUST NOT invent a
second independent full product prompt). Stages SHALL NOT maintain a private full copy of the
repair loop once migrated.

On repair success, the stage SHALL proceed with the repaired output. On exhaustion of the
budget with validation still failing, the stage SHALL NOT perform the gated side effect and
SHALL emit a terminal pure-shape failure as specified by the harness-contract diagnostic
requirement.

#### Scenario: First pure shape failure triggers one repair re-prompt

- **WHEN** a registered contract's validate returns not-ok on the first successful harness exit
- **AND** the contract opts into format-repair
- **AND** the shared repair budget for that attempt has not been spent
- **THEN** the policy SHALL re-invoke the harness once with a format-repair addendum
- **AND** SHALL re-validate the repair output before any gated side effect

#### Scenario: Second automatic repair is not performed

- **WHEN** the single shared repair attempt still fails validation
- **THEN** the policy SHALL NOT perform a further automatic format-repair re-prompt under the
  default budget
- **AND** SHALL return terminal contract failure to the stage

#### Scenario: Plan-revision private repair loop is eliminated

- **WHEN** the plan-revision path handles a pure acknowledgement shape failure
- **THEN** it SHALL use the shared format-repair policy
- **AND** SHALL NOT keep a plan-revision-only full retry skeleton that duplicates the shared
  budget and re-prompt rules

#### Scenario: Repair success unblocks the side effect

- **WHEN** the repair re-prompt produces output that passes the contract validate function
- **THEN** the stage SHALL proceed with that output
- **AND** SHALL NOT remain blocked for the prior shape failure

---

### Requirement: Exhausted pure shape failures SHALL emit harness-contract diagnostics

The stage SHALL emit or project a `pipeline/stage-diagnostic@1` record whose reason code is
`harness-contract` (or an exhaustive pure projection of that reason through the closed
vocabulary) when the shared format-repair budget is exhausted and validation still fails for a
pure output shape reason (missing required sections, unparseable schema-backed JSON, OpenSpec
singularity violation, or equivalent registered shape failure). The failure SHALL NOT be
classified solely as product `human-decision-required` and SHALL NOT park solely as
`needs-human` for shape failure alone.

Harness process failures (non-zero exit, timeout, spawn/capture transport errors) remain
classified under their existing mechanical mappings and are distinct from pure shape failure
after a successful harness exit.

#### Scenario: Exhausted plan-revision shape failure is harness-contract

- **WHEN** plan-revision exits successfully but acknowledgement validation fails after the
  shared repair budget is exhausted
- **THEN** the emitted diagnostic reason SHALL be `harness-contract`
- **AND** SHALL NOT be solely `human-decision-required` for that shape failure

#### Scenario: Capture errors remain distinct mechanical classes

- **WHEN** a harness result sets `timed_out` or `capture_error` before product validation
- **THEN** classification SHALL follow the existing mechanical harness mappings
- **AND** SHALL NOT require free-form prose matching as the primary signal

#### Scenario: No parallel diagnostic taxonomy

- **WHEN** terminal pure shape failures are classified
- **THEN** production code SHALL use `pipeline/stage-diagnostic@1` reason codes
- **AND** SHALL NOT introduce a second independent top-level reason enum for output-contract
  failures

---

### Requirement: Adapter envelope normalization SHALL stay separate from stage-schema validation

Adapter-specific envelope normalization SHALL complete before stage-output-contract validation
when both apply (telemetry frames, transport wrappers, capture packaging). Stage contract
validators SHALL operate on product output and SHALL NOT branch acceptance criteria on harness
or provider name. Named Claude, Grok, and Codex response shapes SHALL exist only as golden
fixtures for regression tests.

#### Scenario: Validation does not branch on provider name

- **WHEN** the stage-output-contract validation modules are inspected by test
- **THEN** they SHALL NOT contain runtime branches that accept or reject shapes based on
  harness or provider name
- **AND** a regression test SHALL fail if such a branch is introduced in the validation path

#### Scenario: Envelope normalization precedes product validation

- **WHEN** an adapter produces an envelope-wrapped stdout that yields a valid product body after
  normalization
- **THEN** stage-schema validation SHALL run on the normalized product body
- **AND** SHALL NOT require the raw envelope to satisfy the product contract

---

### Requirement: Golden shape fixtures SHALL drift-guard cross-harness shapes

The test suite SHALL include golden fixtures for at least: a Grok mid-line / preamble-glued
`## Feedback Incorporated` acknowledgement that is accepted under `plan-revision.ack@1`, a
well-formed line-start Claude acknowledgement, a review fenced JSON verdict accepted under
`review.verdict@1`, and an OpenSpec multi-change filesystem snapshot rejected under
`openspec.change-singular@1`. Fixture tests SHALL call the same validate functions production
uses. Extension adapters SHALL be able to register additional golden fixtures through a
documented hook or discovery path without modifying provider-specific validation branches.

#### Scenario: Grok mid-line ack fixture is accepted

- **WHEN** the golden Grok mid-line acknowledgement fixture is validated under
  `plan-revision.ack@1`
- **THEN** validation SHALL succeed
- **AND** the fixture path SHALL be checked into the repository as a permanent regression case

#### Scenario: Multi-change OpenSpec fixture is rejected

- **WHEN** the golden multi-change OpenSpec singularity fixture is validated under
  `openspec.change-singular@1`
- **THEN** validation SHALL return not-ok with a reason indicating more than one change was
  produced

#### Scenario: Extension fixture hook does not fork validators

- **WHEN** an extension adapter registers a golden fixture for a registered contract id
- **THEN** the fixture SHALL be evaluated by the same central validate function
- **AND** SHALL NOT require a new provider-named validation branch in production code

### Requirement: Freeform markdown stage-output contracts SHALL validate complete product text after envelope normalization

Registered freeform and markdown-section stage-output contracts (including `plan-revision.ack@1`) SHALL validate the **product** harness output after adapter envelope normalization — meaning the complete plain assistant text intended for stage consumers — and SHALL NOT validate a raw telemetry envelope fragment that is incomplete solely because machine-readable capture used tail bounding for cost recovery.

Envelope normalization for streaming machine-readable adapters SHALL therefore yield product text that includes leading streamed content required by those contracts when that content was present in the live assistant stream. A pure shape failure reported by a freeform contract MUST mean the product text lacked the required shape, not that the telemetry capture window discarded it.

#### Scenario: plan-revision.ack@1 sees complete product text

- **WHEN** central validation runs `plan-revision.ack@1` after a successful plan-revision harness exit
- **THEN** the `stdout` (or equivalent product field) passed into the contract’s pure `validate` function SHALL be the complete reconstructed product text for that invocation
- **AND** SHALL NOT be a telemetry-tail-only reconstruction that omitted a leading acknowledgement present in the live stream

#### Scenario: Pure shape failure remains product-true

- **WHEN** a freeform contract validate returns not-ok after normalisation
- **THEN** that not-ok result SHALL reflect absence or malformation in the complete product text
- **AND** the shared format-repair policy MAY re-prompt for true product shape failures
- **AND** the pipeline SHALL NOT classify a capture/reconstruction head-loss of an otherwise valid streamed section as a model shape failure for that same product text

### Requirement: Contract-failing harness output SHALL be an owned operation observation

When central validation returns not-ok after the shared format-repair policy, the owning stage adapter SHALL emit a typed operation observation. The adapter SHALL NOT perform the gated side effect. The adapter SHALL NOT declare the Logical Operation complete, cancelled, or human-owned solely because the output failed the contract. RecoverySupervisor SHALL own treatment or Cooling.

#### Scenario: Unparseable review verdict stays owned

- **WHEN** reviewer stdout cannot be parsed into a schema-satisfying verdict under `review.verdict@1` after repair budget exhaustion
- **THEN** the failure SHALL be classified as an output-contract observation
- **AND** SHALL NOT be recorded as a successful verdict with zero findings
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Failed plan-revision ack stays owned

- **WHEN** plan-revision stdout fails `plan-revision.ack@1` after repair budget exhaustion
- **THEN** the pipeline SHALL NOT post the revised plan as an issue comment
- **AND** the adapter SHALL emit an observation
- **AND** SHALL NOT mark the Logical Operation complete or cancelled
