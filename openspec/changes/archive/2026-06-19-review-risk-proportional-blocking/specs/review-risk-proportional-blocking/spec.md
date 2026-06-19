## ADDED Requirements

### Requirement: The `review-1` risk tier SHALL be derived structurally from its verdict

The pipeline SHALL classify a completed `review-1` round as **low** risk when its
verdict is `approve` with zero findings, and **standard** risk otherwise. This
classification SHALL be computed from the structured `ReviewVerdict` (its
`verdict` value and `findings` length) and SHALL NOT be parsed from the
reviewer's free-text `summary` or any other prose field.

#### Scenario: Approve with zero findings is low risk

- **WHEN** `review-1` returns `verdict: "approve"` with an empty `findings` array
- **THEN** the `review-1` risk tier SHALL be classified **low**

#### Scenario: Any findings make it standard risk

- **WHEN** `review-1` returns a verdict that carries one or more findings (whether it `approve`s or `needs-attention`)
- **THEN** the `review-1` risk tier SHALL be classified **standard**

#### Scenario: Risk is not read from prose

- **WHEN** `review-1`'s `summary` text begins with `Risk: low` but its `findings` array is non-empty
- **THEN** the `review-1` risk tier SHALL be classified **standard**, ignoring the prose `Risk:` self-report

### Requirement: The `review-1` risk tier SHALL be carried as a structured sentinel and read back by `review-2`

The `review-1` comment SHALL carry a structured risk sentinel of the form
`<!-- pipeline-review1-risk: <tier> -->` where `<tier>` is `low` or `standard`,
emitted by the review stage from the derived tier. When `review-2` runs, the
stage SHALL recover the tier by reading the latest such sentinel from the issue
comments. When no recognized sentinel is present, the recovered tier SHALL
default to **standard**.

#### Scenario: Sentinel round-trips low risk

- **WHEN** `review-1` is classified low risk and posts its comment
- **THEN** the comment SHALL contain `<!-- pipeline-review1-risk: low -->`
- **AND** the subsequent `review-2` round SHALL recover the tier **low** from it

#### Scenario: Missing sentinel defaults to standard

- **WHEN** `review-2` runs and no `pipeline-review1-risk` sentinel is present on any comment
- **THEN** the recovered `review-1` risk tier SHALL be **standard**

### Requirement: `review-2` SHALL scale its effective blocking threshold by the captured `review-1` risk

The `review-2` round SHALL partition its findings against an **effective**
`block_threshold` derived from `review_policy.risk_proportional` and the captured
`review-1` risk tier. When `risk_proportional` is `true` and the captured tier is
**low**, the effective `block_threshold` SHALL be the stricter (higher severity
rank) of the configured `block_threshold` and `high` — so a configured threshold
of `low` or `medium` becomes `high`, while `high` and `critical` are left
unchanged. In all other cases — `risk_proportional` is `false`, the round is
`review-1`, or the captured tier is **standard** — `review-2` SHALL partition
against the configured `block_threshold` unchanged. The `min_confidence` floor
SHALL NOT be altered by this scaling in any case. The scaling SHALL be applied by
handing the effective policy to the existing finding-partition gate; the partition
logic itself SHALL be unchanged.

#### Scenario: Low risk relaxes a medium-blocking threshold to high

- **WHEN** `risk_proportional` is `true`, the captured `review-1` risk is **low**, the configured `block_threshold` is `medium`, and `review-2` emits a single `medium`-severity finding
- **THEN** that finding SHALL be advisory and the item SHALL advance rather than route to `fix-2`

#### Scenario: Low risk still blocks high+ findings

- **WHEN** `risk_proportional` is `true`, the captured `review-1` risk is **low**, and `review-2` emits a `high`-severity finding
- **THEN** that finding SHALL block and the item SHALL route to `fix-2`

#### Scenario: Standard risk uses the configured threshold

- **WHEN** `risk_proportional` is `true`, the captured `review-1` risk is **standard**, the configured `block_threshold` is `medium`, and `review-2` emits a `medium`-severity finding
- **THEN** that finding SHALL block and the item SHALL route to `fix-2`

#### Scenario: Flag off preserves current behavior

- **WHEN** `risk_proportional` is `false`, the captured `review-1` risk is **low**, the configured `block_threshold` is `medium`, and `review-2` emits a `medium`-severity finding
- **THEN** that finding SHALL block exactly as it does without this capability

#### Scenario: A stricter configured threshold is never loosened below itself

- **WHEN** `risk_proportional` is `true`, the captured `review-1` risk is **low**, and the configured `block_threshold` is `critical`
- **THEN** the effective `review-2` threshold SHALL remain `critical` and SHALL NOT be lowered to `high`

#### Scenario: The confidence floor is preserved under scaling

- **WHEN** `review-2`'s effective threshold has been raised to `high` for a low-risk change
- **THEN** the active `min_confidence` floor SHALL apply unchanged to the high/critical findings being evaluated
