## MODIFIED Requirements

### Requirement: The scheduler SHALL serialize by default and admit concurrency only under an explicit run policy with proven independence

The scheduler SHALL treat serial execution as the default and SHALL admit more than one item into
`in_progress` at a time only when the loop contract carries a `concurrency` run policy whose budget
is greater than one **and** the additional items are proven independent by every independence check
this capability defines. When no `concurrency` policy is present, or its budget is one, the scheduler
SHALL select exactly one item and item selection SHALL be identical to the existing serialized
single-active-item behavior. A budget greater than one SHALL never by itself cause a
second item to start — proof of independence is always required. The scheduler SHALL be a pure,
deterministic decision that, in unit tests, runs with no real network, git, or subprocess calls.

The supervisor SHALL handle a rejected or crashed dispatch uniformly across serialized and
concurrent execution: it SHALL durably record the dispatched item under the
`workflow-engine-defect` blocker class with a typed engine-defect diagnostic and route it through
the bounded recovery controller, rather than rethrowing the rejection synchronously out of the
scheduling cycle under the serialized default. When the item's durable state is already `blocked`
with canonical recovery evidence, the supervisor SHALL enter recovery on that persisted evidence
instead of blocking the item a second time. One exception SHALL propagate the rejection's
message/reason unchanged: an item already `blocked` without canonical recovery evidence SHALL NOT
be re-blocked or reclassified as an engine defect — the rejection's message is rethrown out of the
cycle so the original interruption remains owned by its existing recovery path.

#### Scenario: Absent policy schedules exactly one item

- **WHEN** the contract carries no `concurrency` run policy and several items are eligible
- **THEN** the scheduler SHALL select exactly one item
- **AND** the selection SHALL match the existing serialized behavior

#### Scenario: A budget above one still requires proof

- **WHEN** the `concurrency` budget is greater than one but no additional eligible item is proven
  independent of the first
- **THEN** the scheduler SHALL select exactly one item

#### Scenario: Concurrency is admitted only with a policy and proof

- **WHEN** the `concurrency` budget is greater than one and additional eligible items are each
  proven independent
- **THEN** the scheduler SHALL admit them up to the budget

#### Scenario: A serialized dispatch rejection enters durable recovery instead of crashing the cycle

- **WHEN** no `concurrency` policy is present and the single dispatched item's execution rejects
- **THEN** the supervisor SHALL durably record that item under the `workflow-engine-defect` class
  with a typed engine-defect diagnostic
- **AND** it SHALL route the item through the bounded recovery controller rather than rethrowing
  the rejection out of the scheduling cycle

#### Scenario: An already-blocked item without canonical recovery evidence propagates the rejection

- **WHEN** a dispatch rejection is reported for an item whose durable state is already `blocked`
  without canonical recovery evidence
- **THEN** the supervisor SHALL NOT block or reclassify the item a second time
- **AND** it SHALL propagate the rejection's message/reason so the original interruption remains
  owned by its existing recovery path
