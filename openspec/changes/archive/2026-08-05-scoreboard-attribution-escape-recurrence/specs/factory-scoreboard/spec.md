## ADDED Requirements

### Requirement: Factory scoreboard SHALL report human-touch rates with explicit denominators

The `pipeline scoreboard` command SHALL compute human-touch aggregates over included runs
from durable intervention and operator-action records (overrides, unblocks, recorded merge
authority actions, hand stage-tags when recorded, manual worktree removes when recorded).
It SHALL expose at minimum:

- `human_touches_per_attempted_issue`: total counted touches / distinct issues attempted in
  the window
- `human_touches_per_r2d_issue`: touches on issues that reached ready-to-deploy / distinct
  R2D issues

Each rate SHALL be a `RateValue` (`numerator`, `denominator`, `ratio`) with `ratio: null`
when the denominator is zero. The scoreboard SHALL NOT convert wall-clock intervals into
human labor minutes. By-kind counts SHALL be included when kinds are present on events.

#### Scenario: JSON exposes per-attempted and per-R2D touch rates

- **WHEN** `pipeline scoreboard --json` covers two attempted issues, one of which reached
  R2D, with three durable human-touch events on the R2D issue and none on the other
- **THEN** `human_touches_per_attempted_issue` SHALL have numerator `3` and denominator `2`
- **AND** `human_touches_per_r2d_issue` SHALL have numerator `3` and denominator `1`

#### Scenario: Zero attempted issues yields null ratios

- **WHEN** the window includes no attempted issues
- **THEN** both human-touch ratios SHALL be `null`

#### Scenario: Wall-clock spans are not labor minutes

- **WHEN** two human_intervention events are 16 minutes apart
- **THEN** the scoreboard SHALL NOT emit a labor-minutes metric derived from that span
- **AND** it SHALL still count discrete touch events

---

### Requirement: Factory scoreboard SHALL report escape-recurrence for seeded defect classes

The scoreboard SHALL compute the escape-recurrence aggregate defined by
`escape-recurrence-tracking` over durable ledgers, control attributions, and release
observations available offline. JSON output SHALL include the overall `RateValue` and
per-key rows for seed keys. Missing fix boundaries SHALL appear as diagnostics, not as
false non-recurrence success.

#### Scenario: Recurrent class appears in scoreboard JSON

- **WHEN** a seed class has a fix boundary and a post-boundary occurrence in included
  evidence
- **THEN** `pipeline scoreboard --json` SHALL report a non-zero escape-recurrence
  numerator that includes that class
- **AND** the per-key row for that class SHALL be present

#### Scenario: Missing boundary is diagnosed

- **WHEN** a seed class has occurrences but no fix boundary
- **THEN** diagnostics SHALL include a stable missing-boundary code
- **AND** the class SHALL NOT be treated as a successful non-recurrence in the ratio
  denominator

---

### Requirement: Factory scoreboard SHALL report discovery-channel decomposition

The scoreboard SHALL decompose issue arrivals and auto-filed/defect observations in the
window by `discovery-channel` (`live-run`, `review-batch`, `papercut-autofile`, `manual`)
using stamped or inherited fields. Counts SHALL use explicit denominators (for example
total attributed arrivals). Unstamped historical items SHALL fall into a missing-attribution
bucket, not into `live-run` by default.

#### Scenario: Batch filings do not count as live-run

- **WHEN** ten issues in the window carry `discovery-channel: papercut-autofile` and two
  carry `live-run`
- **THEN** the discovery-channel breakdown SHALL count `papercut-autofile: 10` and
  `live-run: 2`
- **AND** it SHALL NOT fold the ten auto-filed issues into `live-run`

#### Scenario: Missing channel is not silently live-run

- **WHEN** an arrival lacks discovery-channel and cannot inherit one
- **THEN** it SHALL contribute to a missing-attribution count or diagnostic
- **AND** it SHALL NOT be counted as `live-run`

---

### Requirement: Factory scoreboard SHALL trend engine-class needs-human release-over-release without duplicating FRG math

The scoreboard SHALL expose a release-over-release series for engine-class needs-human rate
(or the existing engine-class rate field family) keyed by release version. When #757 FRG
trend-ledger / release observation artifacts are present, the series SHALL consume those
observations for version identity and recorded rates rather than re-scoring FRG pack
composition. When the ledger is absent, the scoreboard MAY fall back to release-tag × run
window aggregation using existing engine-class classification rules and SHALL emit a
diagnostic that fallback fidelity is in use. Threshold values (K, max engine-class rate)
SHALL NOT be changed by this metric.

#### Scenario: FRG ledger entries populate release series

- **WHEN** FRG trend-ledger entries exist for `v1.30.0` and `v1.31.0` with engine-class
  rates
- **THEN** `pipeline scoreboard --json` release-over-release series SHALL include those
  versions with rates matching the ledger observations (not a second formula)

#### Scenario: Missing ledger falls back with diagnostic

- **WHEN** no FRG trend ledger is present but release tags and run artifacts exist
- **THEN** the scoreboard SHALL still produce a valid report
- **AND** diagnostics SHALL note FRG observation fallback or missing ledger

---

### Requirement: Factory scoreboard SHALL report stratified stabilization metrics with named denominators

The scoreboard SHALL compute the following metrics (or documented equivalent JSON keys)
over the selected window, each as counts and/or `RateValue`s with explicit denominators:

1. Intervention-free first-attempt ready-to-deploy rate
2. Eventual ready-to-deploy within bounded attempts
3. False product-judgment rate (engine-owned recoverable class projected as
   product/human_authority)
4. Engine blockers per 100 stage attempts
5. Recovery success, exhaustion, attempts, resumes, and time-by-reason from recovery
   attempt/result events (post-#787 semantics)
6. First-pass approval rate, fix-round counts, and recurring findings counts from durable
   review/fix evidence
7. Final green/current/mergeable R2D rate when CI/mergeability evidence is present
8. Orphan followers, progress gaps, stale worktrees, and false capacity waits when durable
   diagnostics exist
9. Evidence coverage and missingness for attribution and metric prerequisites

Classification SHALL prefer canonical stage diagnostics and recovery attempt/result events
over issue labels or free-text comments. When a denominator is zero, `ratio` SHALL be
`null`. Missing evidence SHALL be counted in coverage/missingness, not silently coerced to
zero success.

#### Scenario: Intervention-free first-attempt R2D uses explicit denom

- **WHEN** three issues reach R2D and only one has zero human interventions and a
  first-attempt path
- **THEN** intervention-free first-attempt R2D numerator SHALL be `1` and denominator `3`

#### Scenario: Engine blockers per 100 stage attempts

- **WHEN** the window has 50 stage attempts and 2 engine-class blocker events
- **THEN** engine blockers per 100 stage attempts SHALL equal `4`
- **AND** the JSON SHALL expose the raw numerator and denominator used

#### Scenario: Recovered same-run blocker is not terminal off-ramp

- **WHEN** a blocker is recovered by later same-run re-entry and durable recovery evidence
  marks success (post-#787 semantics)
- **THEN** that path SHALL NOT count as a terminal needs-human off-ramp in the new
  stabilization aggregates
- **AND** recovery success counts SHALL include the successful recovery

#### Scenario: False product-judgment uses typed projections

- **WHEN** a recovery class is engine-owned and durable diagnostics show a false
  product/human_authority projection
- **THEN** the false product-judgment numerator SHALL increment
- **AND** the scoreboard SHALL NOT classify solely by scraping issue labels

#### Scenario: Missing CI evidence does not invent green R2D rate

- **WHEN** issues are R2D but CI/mergeability evidence is missing
- **THEN** final green/current/mergeable R2D ratio SHALL be `null` or exclude those issues
  from the denominator per documented rule
- **AND** missingness counts SHALL increase

---

### Requirement: Factory scoreboard SHALL report candidate-integrity observability metrics

The scoreboard SHALL report candidate-integrity observability metrics from durable #857
events in included runs, by mutation method and by engine/version when available:

- candidate-moving repairs and restacks
- review/readiness invalidations caused by a changed candidate
- scope expansions and unverified comparisons detected before ready-to-deploy
- invariant failures caught after repair, including affected path class
- post-merge invariant escapes linked to originating repair or restack

These metrics SHALL be observability only: the scoreboard SHALL NOT introduce promotion or
blocking thresholds from them. When no candidate-integrity events exist in the window,
counts SHALL be zero and a missing-evidence diagnostic MAY be emitted; ratios SHALL use
explicit denominators (for example mutations attempted) with `null` when denom is zero.

#### Scenario: Scope expansion invalidations are counted

- **WHEN** included runs contain two candidate-integrity events classified as scope
  expansion that invalidated review
- **THEN** the scoreboard JSON SHALL report at least count `2` for scope-expansion
  invalidations
- **AND** it SHALL NOT mark the scoreboard as a blocking gate outcome

#### Scenario: Absent candidate-integrity events yield zeros not fabricated rates

- **WHEN** the window has runs but no candidate-integrity events
- **THEN** candidate-integrity counts SHALL be `0`
- **AND** any related ratio SHALL be `null` when its denominator is `0`

---

### Requirement: New stabilization metrics SHALL appear in human-readable scoreboard output and compose with buckets

The scoreboard SHALL include labelled human-readable sections or rows for human-touch
rates, escape-recurrence, discovery-channel breakdown, release-over-release engine-class
needs-human (when series present), stratified stabilization metrics, and candidate-
integrity observability (when events or zeros are reported). When `--bucket day|week` is
supplied, period `metrics` SHALL recompute applicable window-local aggregates using the
same definitions; full-window summary values SHALL remain identical whether or not
`--bucket` is supplied for the same artifacts. HTML export, when used, SHALL not be
required for these metrics to be considered complete (#427 remains separate).

#### Scenario: Human report includes escape-recurrence and human-touch headings

- **WHEN** `pipeline scoreboard` runs over a non-empty window
- **THEN** stdout SHALL include human-readable entries for human-touch rates and
  escape-recurrence (including null/empty presentation when applicable)

#### Scenario: Bucketed periods recompute without changing full-window summary

- **WHEN** `pipeline scoreboard --json` and `pipeline scoreboard --json --bucket day` run
  on the same window and artifacts
- **THEN** full-window human-touch and escape-recurrence values SHALL match
- **AND** series period metrics SHALL be period-local only
