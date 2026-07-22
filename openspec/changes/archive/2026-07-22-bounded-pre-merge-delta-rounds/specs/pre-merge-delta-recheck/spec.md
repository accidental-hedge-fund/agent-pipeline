## ADDED Requirements

### Requirement: The pipeline SHALL count an item's prior pre-merge delta rounds purely from the durable comment thread

The pipeline SHALL expose a pure, deterministic function that returns the number of pre-merge delta rounds already performed for an issue, computed only from that issue's comment list. A comment SHALL count as one delta round when its body begins with the delta-review marker prefix (`## Pre-merge Delta Review`) and its author is the authenticated pipeline actor or a trusted override actor. The function SHALL perform no filesystem, network, git, or subprocess access, and SHALL NOT read run-local state under the run directory, so the count survives a crashed run, a fresh clone, and a host switch.

#### Scenario: Count is derived from trusted delta-review comments

- **WHEN** an issue's comment thread contains three comments authored by the pipeline actor whose bodies begin with the delta-review marker prefix, interleaved with unrelated comments
- **THEN** the counting function SHALL return 3

#### Scenario: Untrusted or non-delta comments are not counted

- **WHEN** a comment begins with the delta-review marker prefix but was authored by an identity that is neither the pipeline actor nor a trusted override actor
- **THEN** that comment SHALL NOT contribute to the count

#### Scenario: Counting is pure

- **WHEN** the counting function is invoked twice with the same comment list
- **THEN** it SHALL return the same value both times
- **AND** SHALL make no filesystem, network, git, or subprocess call

---

### Requirement: Pre-merge SHALL cap delta rounds per item at `review_policy.max_delta_rounds` and apply `ceiling_action` at the ceiling

Before invoking the reviewer for a pre-merge delta round, `enforceReviewShaGate` SHALL compare the item's durable delta-round count to `review_policy.max_delta_rounds`. When the count is greater than or equal to the cap, the pipeline SHALL NOT invoke the reviewer for another delta round and SHALL instead dispose of the item's outstanding blocking delta findings through the configured `ceiling_action`:

- Under `ceiling_action: park`, the pipeline SHALL route the item to the `needs-human` terminal with a punch list of the unresolved blocking delta findings.
- Under `ceiling_action: demote_and_advance`, the pipeline SHALL record below-high blocking delta findings as audited advisory dispositions, capture them in a single tracked follow-up issue, and allow pre-merge to proceed.
- Under either setting, an outstanding blocking delta finding of severity `high` or `critical` SHALL hard-park the item at `needs-human`, mirroring the review-2 ceiling behavior.

The comment the pipeline posts at the ceiling SHALL name the observed round count, the configured cap, and the applied `ceiling_action`. When the count is below the cap, behavior SHALL be unchanged from before this requirement.

#### Scenario: At the cap the reviewer is not invoked again

- **WHEN** an item's durable delta-round count equals `review_policy.max_delta_rounds` and pre-merge re-enters the SHA gate with a changed diff hash
- **THEN** the pipeline SHALL NOT invoke the delta-review seam
- **AND** SHALL apply the configured `ceiling_action`
- **AND** SHALL post a comment naming the observed count, the cap, and the applied action

#### Scenario: Ceiling under park routes to needs-human

- **WHEN** the delta-round cap is reached with outstanding blocking delta findings and `ceiling_action` is `park`
- **THEN** the item SHALL be routed to the `needs-human` terminal
- **AND** the posted punch list SHALL enumerate the unresolved blocking delta findings

#### Scenario: Ceiling under demote_and_advance demotes below-high findings and advances

- **WHEN** the delta-round cap is reached, `ceiling_action` is `demote_and_advance`, and every outstanding blocking delta finding is below `high` severity
- **THEN** those findings SHALL be recorded as audited advisory dispositions
- **AND** SHALL be captured in a single tracked follow-up issue
- **AND** `enforceReviewShaGate` SHALL allow pre-merge to proceed

#### Scenario: High or critical findings hard-park regardless of ceiling_action

- **WHEN** the delta-round cap is reached with at least one outstanding blocking delta finding of severity `high` or `critical` and `ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL be routed to the `needs-human` terminal
- **AND** SHALL NOT advance past pre-merge

#### Scenario: Below the cap behavior is unchanged

- **WHEN** an item's durable delta-round count is strictly less than `review_policy.max_delta_rounds`
- **THEN** the delta review SHALL run exactly as it did before this requirement

---

### Requirement: The delta-round ceiling SHALL be budgeted independently of `max_adversarial_rounds`

Running or ceiling-disposing a pre-merge delta round SHALL NOT increment or consume the `max_adversarial_rounds` review-2 round budget, and reaching `max_adversarial_rounds` SHALL NOT consume delta-round budget. The two ceilings SHALL share only the `ceiling_action` setting.

#### Scenario: Delta rounds do not consume review-2 budget

- **WHEN** an item performs delta rounds up to and including the `max_delta_rounds` ceiling
- **THEN** the `max_adversarial_rounds` counter SHALL be unchanged
- **AND** the item's remaining review-2 ceiling budget SHALL be unchanged

#### Scenario: Review-2 rounds do not consume delta budget

- **WHEN** an item performs review-2 rounds
- **THEN** its durable delta-round count SHALL be unchanged

---

### Requirement: A delta round whose blocking findings show declining confidence on settled axes SHALL be flagged as suspected churn

When the pure churn detector reports suspected churn for a delta round's blocking findings against the prior-round digest, the pipeline SHALL label the posted delta-review comment as a suspected-churn round, naming the settled axes and the prior-versus-new confidences, and SHALL emit exactly one suspected-churn event for that round. The flag SHALL be audit-only: it SHALL NOT by itself change whether the round's findings block, and the round's blocking disposition SHALL be decided by the active `review_policy` and the settled-finding guards exactly as it would without the flag.

#### Scenario: Suspected-churn round is labelled and evented

- **WHEN** a delta round's blocking findings all sit on settled axes at strictly lower confidence than each axis's prior maximum
- **THEN** the posted delta-review comment SHALL carry a suspected-churn label naming the settled axes and the prior and new confidences
- **AND** exactly one suspected-churn event SHALL be emitted for that round

#### Scenario: The churn flag does not alter blocking disposition

- **WHEN** a delta round is flagged as suspected churn
- **THEN** the set of blocking findings SHALL be identical to the set produced for the same findings, policy, overrides, and settled entries without the flag

#### Scenario: A non-churn round carries no label or event

- **WHEN** the churn detector reports no suspected churn for a delta round
- **THEN** the posted comment SHALL carry no suspected-churn label
- **AND** no suspected-churn event SHALL be emitted

---

### Requirement: Delta-round observability SHALL be recorded in the run events and the evidence bundle

For each pre-merge delta round performed, the pipeline SHALL emit one `delta_round` event carrying the round number and the configured cap. When the cap is reached, it SHALL emit one `delta_round_ceiling` event carrying the observed count, the cap, and the applied `ceiling_action`. The evidence bundle SHALL record the item's delta-round count, the configured cap, the ceiling disposition when one occurred, and any suspected-churn flags. As with all evidence-bundle writes, a failure to record SHALL NOT fail the run.

#### Scenario: Each delta round emits a round event

- **WHEN** a pre-merge delta round runs
- **THEN** exactly one `delta_round` event SHALL be appended carrying that round's number and the configured cap

#### Scenario: Ceiling emits a ceiling event

- **WHEN** the delta-round cap is reached
- **THEN** exactly one `delta_round_ceiling` event SHALL be appended carrying the observed count, the cap, and the applied `ceiling_action`

#### Scenario: Evidence bundle records delta-round accounting

- **WHEN** a run performs at least one pre-merge delta round
- **THEN** the evidence bundle SHALL report the delta-round count, the cap, the ceiling disposition when one occurred, and any suspected-churn flags

#### Scenario: Bundle write failure is non-fatal

- **WHEN** recording delta-round accounting into the evidence bundle fails
- **THEN** the run SHALL continue and the pre-merge outcome SHALL be unaffected

---

### Requirement: The five-round oscillation history SHALL be covered by a regression test

The test suite SHALL include a regression test replaying the observed five-delta-round history (PraxisIQ/fuseiq-core#95): four rounds of genuine blocking findings followed by a fifth round re-raising a settled axis under new finding keys, re-worded titles, declining confidence, and a recommendation that reinstates a design a prior round required removed. The test SHALL use fake comment fixtures with no network, git, or subprocess access, and SHALL assert both that the cap prevents the fifth round from being reviewed under the default configuration and that, when the fifth round's findings are partitioned, they are demoted rather than blocking.

#### Scenario: Replay asserts the loop is bounded and the round-5 findings are demoted

- **WHEN** the five-round fixture history is replayed against the gate and the partitioner
- **THEN** the fifth delta round SHALL NOT be invoked under the default `max_delta_rounds`
- **AND** the round-5 findings, when partitioned against the settled entries, SHALL land in the advisory partition
