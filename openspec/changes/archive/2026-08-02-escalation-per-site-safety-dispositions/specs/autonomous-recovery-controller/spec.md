## ADDED Requirements

### Requirement: Stage-diagnostic reason codes SHALL classify harness and forge failures mechanically

The closed `pipeline/stage-diagnostic@1` reason vocabulary SHALL remain the sole escalation
reason enum. The engine SHALL derive harness failure reasons from structured `HarnessResult`
flags — including at least `timed_out`, `spawn_error`, `capture_error`, `oversize_argv`,
`stdin_error`, and `throttled` — and SHALL derive forge/gh failure reasons from structured error
shapes including HTTP 5xx, rate-limit, authentication failure, capability refusal, network
timeouts, and output-contract failures. Classification SHALL NOT depend on free-form prose
matching as the primary signal. The vocabulary MAY gain additive members (for example explicit
timeout, harness-contract, transient-infra, external-wait, repair-budget-exhausted, or
human-context-required codes) when existing members would lossily collapse distinct budget or
metrics classes; the engine SHALL NOT introduce a competing parallel reason enum.

#### Scenario: Timed-out harness result maps without prose scraping

- **WHEN** a harness invocation returns `timed_out: true`
- **THEN** the emitted diagnostic reason SHALL be the mechanical timeout / harness mapping from
  the closed vocabulary
- **AND** classification SHALL NOT require matching free-form stderr text as the primary signal

#### Scenario: Capture or output-contract failure maps to harness-contract class

- **WHEN** a harness result sets `capture_error` or fails the output contract without a product
  finding
- **THEN** the diagnostic SHALL project to an engine-owned harness-contract or
  `workflow-engine-defect` reason
- **AND** SHALL NOT project to `human-decision-required`

#### Scenario: Gh HTTP 5xx maps to transient infrastructure class

- **WHEN** a gh API call fails with HTTP 504 (or other 5xx) during a non-attestation path
- **THEN** the failure SHALL classify as transient infrastructure under the canonical vocabulary
- **AND** a `transient-retryable` site SHALL be eligible for bounded retry before any park

#### Scenario: No competing reason enum is introduced

- **WHEN** the escalation classification modules are inspected
- **THEN** production authority classification SHALL use `pipeline/stage-diagnostic@1` reason
  codes (and pure projections of them)
- **AND** SHALL NOT introduce a second independent top-level reason enum for the same purpose

---

### Requirement: Transient infrastructure failures SHALL NOT park as product judgment

Transient infrastructure failures SHALL classify under an engine-owned recoverable reason and
disposition `recover` (or capacity/wait where applicable), including gh HTTP 5xx / rate-limit
during label edits or other non-attestation mutations, harness throttle, and network blips.
After bounded site-local retry exhaustion, the failure MAY escalate as a typed engine-owned or
environment failure. It SHALL NOT be represented as product judgment, SHALL NOT create a human
hold without the authority predicate, and SHALL NOT be the sole cause of a `needs-human` park
labeled as a product block.

#### Scenario: Label-edit 504 does not become a product hold

- **WHEN** a gh label edit fails with HTTP 504 and the site disposition is `transient-retryable`
- **THEN** the engine SHALL classify the failure as transient infrastructure
- **AND** SHALL retry within the configured budget
- **AND** SHALL NOT park the issue as a product or human-authority block solely because of that
  blip when a retry succeeds or when exhaustion remains typed engine-owned

#### Scenario: Repair-budget exhaustion stays engine-owned

- **WHEN** bounded recovery or site-local retry budget is exhausted for a mechanical class
- **THEN** the terminal outcome SHALL be a typed engine-owned failure or stop
- **AND** the controller SHALL NOT emit `human_intervention` solely from that exhaustion

---
### Requirement: Parallel taxonomies SHALL be exhaustive projections of the canonical reason vocabulary

`BlockerKind`, `HumanInterventionKind`, `PreMergeOfframpClass`, and `DurableBlockerClass` SHALL
be exhaustive pure projections of the canonical stage-diagnostic reason vocabulary (plus closed
site/context tags already carried on the diagnostic detail), or SHALL be retired from independent
authority classification. Loop recovery budgets and recovery-policy keys SHALL consume that same
closed durable class set projected from the vocabulary. No production path SHALL invent a
fifth independent reason taxonomy for escalation authority.

#### Scenario: Durable class projection is total over reason codes

- **WHEN** each closed stage-diagnostic reason code is projected
- **THEN** the projection SHALL yield exactly one `DurableBlockerClass` (or an explicit residual
  protocol-failure path for unknown codes)
- **AND** loop recovery budget keys SHALL use that class set

#### Scenario: Intervention and offramp kinds do not independently authorize holds

- **WHEN** a path would emit `HumanInterventionKind` or `PreMergeOfframpClass`
- **THEN** human-authority status SHALL still be determined only by the stage-diagnostic
  authority projection
- **AND** reporting kinds such as `review-non-convergence` SHALL NOT alone create a human hold
)