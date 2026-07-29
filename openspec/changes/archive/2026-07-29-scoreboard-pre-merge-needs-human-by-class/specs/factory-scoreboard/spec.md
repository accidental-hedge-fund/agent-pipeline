## ADDED Requirements

### Requirement: Factory scoreboard reports pre-merge needs-human rate and breakdown by offramp class

The `pipeline scoreboard` command SHALL compute, over included runs in the selected
window, a **pre-merge needs-human** aggregate derived only from durable run artifacts
(`.agent-pipeline/runs/*/events.jsonl` and related summary fields), not from GitHub issue
comments.

The aggregate SHALL expose at minimum:

- **Denominator** `pre_merge_entries`: the count of included runs that entered pre-merge
  (evidenced by a `stage_start` for stage `pre-merge`, or an equivalent documented
  stage-entry signal pinned by tests).
- **Numerator** `pre_merge_needs_human_count`: the count of durable pre-merge
  blocked/needs-human off-ramp events in those runs that carry (or map to) a
  `PreMergeOfframpClass`.
- **Rate** `pre_merge_needs_human_rate`: numerator/denominator as a scoreboard `RateValue`
  (`numerator`, `denominator`, `ratio`). When the denominator is zero, `ratio` SHALL be
  `null` rather than `0`.
- **By-class breakdown** `pre_merge_needs_human_by_class`: for every
  `PreMergeOfframpClass` member observed or for the full closed set, a count and a
  `RateValue` using the **same** `pre_merge_entries` denominator so class rates are
  comparable. The sum of per-class counts SHALL equal `pre_merge_needs_human_count`.

Classification source priority SHALL be:

1. `blocker_set` (or equivalent off-ramp) events with `stage === "pre-merge"` and a
   present `offramp_class` in the closed set.
2. Else such events with `stage === "pre-merge"` and a mappable `blocker_kind`.
3. Else pre-merge-stage interventions or off-ramps without class SHALL count under
   `other` (or a residual bucket that is part of the closed set), not free-text parsing.

The scoreboard SHALL NOT fetch or parse issue comments to assign classes.

#### Scenario: JSON exposes rate and class breakdown

- **WHEN** `pipeline scoreboard --json` is invoked over a window with three pre-merge
  entries and two pre-merge off-ramps (`ci-failed`, `merge-conflict`)
- **THEN** the parsed JSON `metrics` object SHALL include a pre-merge needs-human
  aggregate whose denominator is `3`, total numerator is `2`, and `ci-failed` and
  `merge-conflict` counts are `1` each
- **AND** the sum of by-class counts SHALL equal the total numerator

#### Scenario: Zero pre-merge entries yields null rate

- **WHEN** the window contains included runs but none entered pre-merge
- **THEN** `pre_merge_needs_human_rate.ratio` SHALL be `null`
- **AND** by-class ratios SHALL be `null`
- **AND** the command SHALL exit zero with a valid report

#### Scenario: Aggregation does not scrape issue comments

- **WHEN** scoreboard computes the pre-merge needs-human aggregate
- **THEN** it SHALL read only local run artifacts under `.agent-pipeline/runs/`
- **AND** it SHALL NOT invoke GitHub APIs to classify off-ramps

#### Scenario: Historical events without offramp_class remain countable

- **WHEN** an included run has a pre-merge blocked event without `offramp_class` but with
  stage `pre-merge`
- **THEN** the aggregate SHALL still count that off-ramp (under `other` or a mapped
  `blocker_kind` when present)
- **AND** the scan SHALL NOT crash

---

### Requirement: Pre-merge needs-human metrics appear in human-readable and HTML scoreboard output

When the scoreboard prints its human-readable report, it SHALL include a section or
labelled rows for the pre-merge needs-human rate and the per-class breakdown (class name,
count, and rate). When `--html <path>` is supplied, the same values SHALL appear in the
exported document, matching the terminal report for that invocation (existing HTML export
parity rule).

#### Scenario: Human report shows class breakdown

- **WHEN** `pipeline scoreboard` is invoked over a window with at least one pre-merge
  off-ramp of class `ci-failed`
- **THEN** stdout SHALL include the overall pre-merge needs-human rate
- **AND** stdout SHALL include a `ci-failed` entry with its count

#### Scenario: HTML export mirrors the metric values

- **WHEN** `pipeline scoreboard --html report.html` is invoked for a given window
- **THEN** `report.html` SHALL contain the same pre-merge needs-human rate and class
  counts as the human terminal report for that invocation

---

### Requirement: Pre-merge needs-human metrics compose with time-series buckets

Each series period's `metrics` object SHALL include the same pre-merge needs-human rate
and by-class shapes when `--bucket day` or `--bucket week` is supplied, computed only from
runs (and their pre-merge events) assigned to that period, using the same definitions as
the full-window aggregate. The full-window summary values SHALL remain identical whether
or not `--bucket` is supplied for the same window and artifacts.

#### Scenario: Day bucket carries per-period pre-merge class counts

- **WHEN** `pipeline scoreboard --bucket day --json` covers a window with a `ci-failed`
  off-ramp on day D1 and a `delta-review` off-ramp on day D2
- **THEN** the D1 period metrics SHALL count `ci-failed` and the D2 period metrics SHALL
  count `delta-review`
- **AND** the full-window by-class counts SHALL equal the sum of the period counts for
  each class

---

### Requirement: Dogfood-day query path is documented for pre-merge class breakdown

Documentation SHALL describe how an operator obtains a single-day or custom-window
pre-merge needs-human class breakdown using existing `pipeline scoreboard` flags. The
scoreboard help text and the repository user-facing scoreboard section SHALL include at
least one example equivalent to `pipeline scoreboard --days 1 --json` and the JSON path
(or human section name) of the pre-merge needs-human aggregate. Documentation SHALL state
that classification comes from run events, not issue comments. No separate ad-hoc report
script SHALL be required for the dogfood-day query.

#### Scenario: Help mentions the metric or example query

- **WHEN** an operator reads `pipeline scoreboard --help` or the documented scoreboard
  section after this change
- **THEN** they SHALL find enough guidance to produce a one-day JSON report containing the
  pre-merge needs-human by-class aggregate without inventing new flags beyond existing
  window options
