## ADDED Requirements

### Requirement: Treatment comparisons SHALL be paired per fixture against a declared baseline

The report SHALL compare each treatment to a declared baseline treatment by computing, for each
metric, a per-fixture delta between the treatment and the baseline, and SHALL aggregate those
per-fixture deltas. A fixture SHALL contribute a delta only when both the treatment and the baseline
have at least one `completed` cell for it. Fixtures excluded for lack of a pair SHALL be reported
explicitly rather than silently omitted.

Replicates of the same fixture and treatment SHALL be reduced to a single value before pairing, so
that a treatment with more replicates does not gain weight in the aggregate.

#### Scenario: Deltas are computed within a fixture

- **WHEN** a treatment and the baseline both have completed cells for a fixture
- **THEN** the report SHALL compute the metric delta for that fixture
- **AND** the aggregate effect SHALL be computed over the per-fixture deltas

#### Scenario: An unpaired fixture is excluded and reported

- **WHEN** a fixture has a completed cell for the treatment but none for the baseline
- **THEN** that fixture SHALL NOT contribute to the paired aggregate
- **AND** the report SHALL name it as excluded for lack of a pair

#### Scenario: Replicates do not increase a treatment's weight

- **WHEN** one treatment has more replicates for a fixture than another
- **THEN** each fixture and treatment SHALL contribute exactly one value to the pairing
- **AND** the aggregate SHALL be unchanged by the difference in replicate counts

#### Scenario: The baseline is named in the output

- **WHEN** the summary is read
- **THEN** it SHALL name the baseline treatment every delta is relative to

---

### Requirement: The report SHALL report completion and failure-class rates separately from quality

The report SHALL report, for each treatment, the completion rate and the rate of each failure class
(`infra_error`, `auth_error`, `timeout`) over that treatment's planned cells. Failure-class cells
SHALL NOT contribute to any quality metric, in either direction.

#### Scenario: Reliability rates are reported per treatment

- **WHEN** the summary is read
- **THEN** each treatment SHALL report its completion rate and its `infra_error`, `auth_error`, and
  `timeout` rates
- **AND** the denominator SHALL be that treatment's planned cells

#### Scenario: A timing-out treatment is not rewarded on quality

- **WHEN** a treatment times out on its hardest fixtures and completes only the easy ones
- **THEN** the timed-out fixtures SHALL be excluded from the paired quality comparison
- **AND** the timeout rate SHALL be reported alongside the quality effect

---

### Requirement: Every reported aggregate effect SHALL carry a confidence interval, a sample size, and a reproducible method

Each aggregate effect in the report SHALL be accompanied by a confidence interval and the number of
paired fixtures it was computed from. The summary SHALL record the interval method and any parameter
it depends on, including the seed of any resampling procedure, so that the interval is reproducible.
No randomness used in interval computation SHALL be unseeded.

An effect whose paired sample size is below the report's stated sufficiency threshold SHALL be marked
as underpowered rather than omitted or presented as conclusive.

#### Scenario: Effects are reported with intervals and n

- **WHEN** an aggregate effect is read from the summary
- **THEN** it SHALL carry a confidence interval and the paired sample size

#### Scenario: Interval computation is reproducible

- **WHEN** the same grades are summarized twice
- **THEN** the reported intervals SHALL be identical
- **AND** the summary SHALL record the interval method and its seed or parameters

#### Scenario: A small sample is marked underpowered

- **WHEN** an effect is computed from fewer paired fixtures than the stated sufficiency threshold
- **THEN** the effect SHALL be marked underpowered
- **AND** it SHALL still be reported with its interval and sample size

---

### Requirement: The report SHALL identify quality-versus-duration and quality-versus-cost Pareto frontiers

The report SHALL identify the non-dominated treatments on quality versus duration and on quality
versus cost. A treatment SHALL be dominated when another treatment is at least as good on quality and
strictly better on the other axis. The report SHALL NOT collapse the axes into a single weighted score.

#### Scenario: Non-dominated treatments are listed

- **WHEN** the summary is read
- **THEN** it SHALL list the non-dominated treatments for quality versus duration and for quality
  versus cost

#### Scenario: A faster but worse treatment is not presented as an improvement

- **WHEN** a treatment is faster than the baseline but scores lower on quality
- **THEN** the report SHALL show both the quality effect and the duration difference
- **AND** SHALL NOT report a single combined score that hides the quality loss

#### Scenario: A dominated treatment is excluded from the frontier

- **WHEN** one treatment is at least as good on quality and strictly cheaper than another
- **THEN** the other treatment SHALL be excluded from the cost frontier

---

### Requirement: Results SHALL be groupable by stage, harness, provider or auth class, model, effort, task category, and risk

The report SHALL support grouping results by stage, harness, provider or authentication class,
model, effort, fixture task category, and fixture risk classification. Each grouping SHALL reuse the
same metric definitions as the ungrouped report. A grouping value that is absent from the underlying
records SHALL be reported as an explicit unknown group rather than being dropped or merged into
another group.

#### Scenario: Each supported dimension can be grouped by

- **WHEN** results are grouped by stage, harness, provider or auth class, model, effort, task
  category, or risk
- **THEN** the report SHALL emit one entry per distinct value of that dimension
- **AND** each entry SHALL use the same metric definitions as the ungrouped report

#### Scenario: An absent grouping value becomes an explicit unknown group

- **WHEN** records lack a value for the grouping dimension
- **THEN** those records SHALL be reported under an explicit unknown group
- **AND** SHALL NOT be dropped or merged into a named group

---

### Requirement: Missing token or cost telemetry SHALL be reported as unknown and SHALL NOT be treated as zero

The report SHALL follow the recorded cost provenance. A cell whose cost source is unknown SHALL be
excluded from cost aggregates and counted toward a reported cost-coverage fraction. No cost or token
aggregate SHALL impute zero for missing telemetry, and any cost-derived comparison SHALL state the
coverage it was computed over.

#### Scenario: Unknown cost is excluded, not zeroed

- **WHEN** a completed cell has no cost telemetry
- **THEN** it SHALL be excluded from cost aggregates
- **AND** no cost aggregate SHALL include a zero contributed by that cell

#### Scenario: Cost coverage is reported

- **WHEN** a cost aggregate or cost frontier is reported
- **THEN** the report SHALL state the fraction of contributing cells that had actual or estimated
  cost

#### Scenario: Estimated cost is distinguishable from actual cost

- **WHEN** cost aggregates mix actual and estimated cost sources
- **THEN** the report SHALL state the composition rather than presenting the aggregate as actual
  cost

---

### Requirement: The summary artifact SHALL be additive, stable, and machine-readable

The report SHALL be written as `summary.json` in the experiment's output directory, as a single
machine-readable document carrying a schema version. Writing it SHALL NOT modify the experiment
runner's artifacts or the grade stream, and summarizing the same grades twice SHALL produce a
byte-identical document.

#### Scenario: The summary is versioned and machine-readable

- **WHEN** `summary.json` is read
- **THEN** it SHALL be a single parseable JSON document carrying a schema version

#### Scenario: Summarizing does not mutate its inputs

- **WHEN** the summary is written
- **THEN** the run plan, cell record streams, and grade stream SHALL be byte-identical to their
  contents beforehand

#### Scenario: Summarization is deterministic

- **WHEN** the same grade stream is summarized twice
- **THEN** the two `summary.json` documents SHALL be byte-identical

---

### Requirement: Reporting SHALL be exercised deterministically in continuous integration without live model calls

Aggregation SHALL be covered by tests over checked-in grade records that exercise pairing, unpaired
exclusion, replicate reduction, reliability rates, interval computation and its reproducibility,
Pareto frontier selection, grouping, and unknown-cost handling. These tests SHALL make no live model
call, network request, real git operation, or subprocess spawn.

#### Scenario: Aggregation behavior is covered by deterministic tests

- **WHEN** the test suite runs
- **THEN** pairing, unpaired exclusion, replicate reduction, reliability rates, intervals, Pareto
  selection, grouping, and unknown-cost handling SHALL each be exercised over checked-in records

#### Scenario: Reporting tests need no credentials or network

- **WHEN** the continuous-integration gate runs the reporting tests
- **THEN** no live model call, network request, real git operation, or subprocess spawn SHALL occur
- **AND** the tests SHALL pass with no provider credential configured
