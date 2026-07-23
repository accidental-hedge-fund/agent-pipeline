## MODIFIED Requirements

### Requirement: improve command clusters recurring patterns by category

The analyzer SHALL group run evidence into six named categories: `review-finding` (same normalized
finding title across runs), `blocker` (same normalized blocker reason across runs), `flaky-gate`
(same stage name with repeated `outcome: "error"` events), `token-waste` (stages with anomalously
high duration or token cost when data is available), `papercut` (same normalized `message` across
`papercut` events recorded by agents during runs), and `correction` (recurring `correction_event`
records clustered by their deterministic `correction_key`). Each cluster SHALL record: category,
normalized signal string, occurrence count, affected run IDs, and at least one evidence excerpt
(truncated to ≤ 200 characters). The `correction` category SHALL key its clusters on the event
contract's `correction_key` rather than on `normalizeSignal`, and its per-cluster fields are
specified by the `correction-compiler` capability.

#### Scenario: Repeated review finding titles cluster together

- **WHEN** three runs each record a `review_verdict` finding whose title normalizes to the same string
- **THEN** those findings SHALL be grouped into a single `review-finding` cluster
- **AND** the cluster SHALL list all affected run IDs and an evidence excerpt from the finding body

#### Scenario: Repeated blocker reasons cluster together

- **WHEN** multiple runs record `blocker_set` events whose reason normalizes to the same string
- **THEN** those events SHALL be grouped into a single `blocker` cluster
- **AND** the cluster SHALL list all affected run IDs

#### Scenario: Repeated stage errors cluster as a flaky gate

- **WHEN** the same stage name records `stage_complete` with `outcome: "error"` across multiple runs
- **THEN** those events SHALL be grouped into a single `flaky-gate` cluster
- **AND** the cluster SHALL record the stage name and affected run IDs

#### Scenario: High-duration stages cluster as token waste

- **WHEN** run summaries report the same stage exceeding the high-duration threshold in multiple runs
- **THEN** those runs SHALL be grouped into a single `token-waste` cluster keyed by stage name
- **AND** the cluster SHALL list all affected run IDs

#### Scenario: Token-waste data absent

- **WHEN** no analyzed run summary contains token-count or duration data
- **THEN** the `token-waste` category SHALL be silently omitted from the report
- **AND** the report SHALL note that token-waste analysis was skipped due to absent data

#### Scenario: Repeated papercut messages cluster together

- **WHEN** `papercut` events across two or more runs carry messages that normalize to the same string
- **THEN** those events SHALL be grouped into a single `papercut` cluster
- **AND** the cluster SHALL record the normalized message as its signal, the occurrence count, every
  affected run ID, and an evidence excerpt drawn from the papercut message

#### Scenario: Repeated corrections cluster by correction_key

- **WHEN** `correction_event` records across two or more runs share the same `correction_key`
- **THEN** those records SHALL be grouped into a single `correction` cluster keyed on that
  `correction_key`
- **AND** the cluster's identity SHALL NOT depend on the free-text `correction` prose or any model
  output

#### Scenario: No correction events yields no correction clusters

- **WHEN** the analyzed runs contain no `correction_event` records
- **THEN** the report SHALL contain no `correction` cluster
- **AND** the command SHALL exit 0 with the other categories reported as before

### Requirement: Improve clusters SHALL be isolated by category and never merged across categories

The analyzer SHALL key every cluster by the pair (category, cluster key), so that evidence from
different categories SHALL NEVER accumulate into the same cluster. In particular, an agent-reported
`papercut` cluster SHALL remain a distinct cluster from a telemetry-derived `flaky-gate` or
`token-waste` cluster even when both describe the same underlying problem, a `correction` cluster
SHALL remain distinct from every other category even when its signal coincides with theirs, and the
analyzer SHALL NOT apply any cross-category similarity merging.

#### Scenario: Papercut and flaky-gate describing the same problem stay separate

- **WHEN** agents record `papercut` events about a slow, repeatedly-retried test gate and the same
  runs also record `stage_complete` errors for that stage
- **THEN** the report SHALL contain one `papercut` cluster and one `flaky-gate` cluster
- **AND** the two SHALL carry independent occurrence counts and SHALL NOT be combined into a single
  cluster

#### Scenario: Papercut and token-waste describing the same problem stay separate

- **WHEN** a `papercut` cluster and a `token-waste` cluster both concern the same slow stage
- **THEN** each SHALL be reported under its own category as its own cluster
- **AND** `--apply` SHALL treat them as two independent candidates for issue creation

#### Scenario: Identical normalized signals in different categories do not collide

- **WHEN** a `papercut` signal and a `blocker` signal normalize to the identical string
- **THEN** the analyzer SHALL emit two clusters, one per category
- **AND** neither cluster's occurrence count SHALL include the other category's events

#### Scenario: Correction and papercut describing the same problem stay separate

- **WHEN** a `correction` cluster and a `papercut` cluster concern the same underlying failure and
  their signals coincide
- **THEN** the report SHALL contain one `correction` cluster and one `papercut` cluster
- **AND** their occurrence counts SHALL be independent and SHALL NOT be combined
