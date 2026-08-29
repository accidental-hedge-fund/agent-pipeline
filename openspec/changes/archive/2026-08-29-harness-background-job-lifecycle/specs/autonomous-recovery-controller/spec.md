## ADDED Requirements

### Requirement: Stage diagnostics SHALL include harness-background-wait as an additive reason

The closed `pipeline/stage-diagnostic@1` reason vocabulary SHALL include additive member
`harness-background-wait`. The engine SHALL derive that reason from structured lifecycle
evidence — a typed complete or fail event without notification delivery or foreground-join inside
the effective grace — and SHALL NOT derive it from `HarnessResult.timed_out`, from generic
inactivity, or from free-form transcript matching. Projection of `harness-background-wait` SHALL
be total: exactly one `DurableBlockerClass` and disposition, engine-owned (`workflow-engine-defect`,
disposition `recover`), never `human_authority` from this reason alone. Unknown codes SHALL remain
protocol failures. The engine SHALL NOT introduce a competing parallel reason enum.

#### Scenario: Lifecycle miss maps without prose scraping

- **WHEN** a harness invocation returns structured lifecycle evidence of complete-or-fail without
  delivery or join inside the effective grace
- **THEN** the emitted diagnostic reason SHALL be `harness-background-wait`
- **AND** classification SHALL NOT require matching free-form stderr or transcript text as the
  primary signal

#### Scenario: timed_out does not become harness-background-wait

- **WHEN** a harness invocation returns `timed_out: true` without typed complete-or-fail-without-join
  evidence
- **THEN** the diagnostic reason SHALL remain the mechanical timeout mapping (`harness-timeout`)
- **AND** SHALL NOT be `harness-background-wait`

#### Scenario: Projection is total and engine-owned

- **WHEN** `harness-background-wait` is projected
- **THEN** the projection SHALL yield `DurableBlockerClass` `workflow-engine-defect` and
  disposition `recover`
- **AND** SHALL NOT yield `human_authority` or `human-decision-required` from this reason alone

### Requirement: harness-background-wait SHALL NOT retry the same adapter on the same fingerprint

For diagnostics whose reason is `harness-background-wait`, the recovery policy SHALL NOT claim a
recipe that re-invokes the same adapter on the same invocation fingerprint. Salvage of uncommitted
work MAY still run. Publication, recover-parked, and `publish_unpublished_stage_commit` transitions
SHALL remain unchanged by this reason. Selecting a different adapter SHALL require an existing
explicit harness policy. LLM repair SHALL NOT be the first recoverer for this class. This reason
SHALL NOT mint a human hold.

#### Scenario: Same-adapter implementer repair is not selected

- **WHEN** current evidence is `harness-background-wait` for adapter A and invocation fingerprint F
- **THEN** the controller SHALL NOT start a recipe that re-invokes adapter A on fingerprint F
- **AND** SHALL NOT create a human hold solely for that diagnostic

#### Scenario: This reason does not open the unpublished-commit publish path

- **WHEN** a `harness-background-wait` diagnostic is recorded and a salvage commit exists
- **THEN** this reason SHALL NOT by itself claim `publish_unpublished_stage_commit`
- **AND** SHALL NOT transition the item to `review-1`
