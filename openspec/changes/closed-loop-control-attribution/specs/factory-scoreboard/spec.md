## ADDED Requirements

### Requirement: Factory scoreboard reports repeat-correction metrics deduped by correction instance

The `pipeline scoreboard` command SHALL read `correction_event` records from the included runs'
existing artifacts and report repeat-correction metrics in both the human-readable report and the
`--json` object: the total number of corrections, the number of distinct correction classes, the
repeated-class count and repeated-class rate, and corrections per ready-to-deploy item. A
correction class SHALL be a distinct `correction_key`. Corrections SHALL be counted by distinct
`correction_id`, so replayed or duplicate deliveries of one correction count exactly once. A
repeated class SHALL be a class with two or more distinct corrections. Consistent with this
capability's existing zero-denominator rule, the repeated-class rate and corrections-per-ready-item
SHALL be `null` rather than `0` when their denominator is zero.

#### Scenario: duplicate correction delivery counts once

- **WHEN** the included runs contain two `correction_event` records sharing one `correction_id`
- **THEN** the total-corrections count SHALL increase by exactly one for that `correction_id`

#### Scenario: repeated-class count and rate reported

- **WHEN** the included runs contain three distinct corrections across two `correction_key` classes, one class holding two distinct corrections
- **THEN** the distinct-class count SHALL be `2`
- **AND** the repeated-class count SHALL be `1`
- **AND** the repeated-class rate SHALL expose numerator `1` and denominator `2`

#### Scenario: corrections per ready-to-deploy item uses the successful-PR denominator

- **WHEN** the window has two successful ready-to-deploy PRs and four distinct corrections
- **THEN** corrections-per-ready-item SHALL expose numerator `4` and denominator `2`
- **AND** when there are zero successful PRs the metric SHALL be `null` rather than `0`

### Requirement: Factory scoreboard attributes controls and reports time-to-control

The `pipeline scoreboard` command SHALL read `control_attribution` records from the durable
attribution store and join them to correction classes by `correction_key`. For each class with an
`implemented` attribution, the report SHALL expose the attributed `control_type`, the resolving
issue/PR and effective commit or release, and a `time-to-control` equal to the interval from the
class's first-seen correction timestamp to the attribution's `effective_at`. The scoreboard SHALL
NOT infer attribution from issue or PR activity; only records from the attribution store SHALL
attribute a control.

#### Scenario: an attributed class reports its control and time-to-control

- **WHEN** a `correction_key` was first seen at T0 and an `implemented` `control_attribution` for it has `effective_at = T1`
- **THEN** the report SHALL show that class's `control_type` and resolving issue/PR
- **AND** its `time-to-control` SHALL be the interval from T0 to T1

#### Scenario: an unattributed class reports no control

- **WHEN** a recurring `correction_key` has no `control_attribution` in the store
- **THEN** the report SHALL show the class as unattributed
- **AND** it SHALL NOT synthesize a control from a closed issue or merged PR

### Requirement: Factory scoreboard measures post-control recurrence only over eligible exposure

For each `correction_key` with an `implemented` attribution, the scoreboard SHALL measure
recurrence only over **subsequent eligible run exposure**: included runs whose resolved start
timestamp (the same timestamp used for window filtering) is strictly after the attribution's
`effective_at` and that exercised the class's stage — evidenced by a `stage_start`/`stage_complete`
for that stage, or, for a null-stage class, any included run after the boundary. The scoreboard
SHALL classify each attributed class as exactly one of `recurred` (an eligible post-control run
emitted the class), `no_recurrence_observed` (one or more eligible post-control runs, none of which
emitted the class), or `insufficient_post_control_evidence` (zero eligible post-control runs). A
class with zero eligible post-control runs SHALL NOT be reported as `no_recurrence_observed`.

#### Scenario: recurrence after a gate falls to no recurrence observed

- **WHEN** a class has an `implemented` `deterministic-gate` attribution and two eligible post-control runs, neither emitting the class
- **THEN** the class SHALL be classified `no_recurrence_observed`

#### Scenario: a documentation-only control that keeps recurring is reported as recurred

- **WHEN** a class has an `implemented` `instruction` attribution and an eligible post-control run still emits the class
- **THEN** the class SHALL be classified `recurred`
- **AND** the report SHALL NOT present the documentation-only control as having stopped the correction

#### Scenario: zero post-control exposure is insufficient evidence

- **WHEN** a class has an `implemented` attribution but no included run started after `effective_at` that exercised its stage
- **THEN** the class SHALL be classified `insufficient_post_control_evidence`
- **AND** it SHALL NOT be classified `no_recurrence_observed`

### Requirement: Factory scoreboard reports recurrence temporally and surfaces superseded and rolled-back controls

The scoreboard SHALL report recurrence as temporal attribution and evidence, and SHALL NOT claim
that a control caused a change in recurrence. When a `control_attribution` carries a `supersedes`
pointer, the scoreboard SHALL use the latest non-`rejected` implemented attribution as the class's
active boundary, SHALL re-measure recurrence from that boundary, and SHALL surface the superseded
or rolled-back control in the report rather than hiding it.

#### Scenario: report avoids a causal claim

- **WHEN** the recurrence report is rendered for an attributed class
- **THEN** it SHALL state the control's effective time and the observed recurrence over eligible exposure
- **AND** it SHALL NOT assert that the control caused the recurrence change

#### Scenario: superseded control is re-measured from the new boundary and shown

- **WHEN** attribution B supersedes an earlier implemented attribution A for one `correction_key`
- **THEN** post-control recurrence SHALL be measured from B's `effective_at`
- **AND** the report SHALL still surface A as superseded rather than omitting it

### Requirement: Factory scoreboard groups correction metrics by a single correction dimension

The `pipeline scoreboard` command SHALL accept an optional `--corrections-by <dimension>` flag
whose only supported values are `repo`, `stage`, `harness`, `model`, `source_kind`,
`failure_class`, `proposed_control`, and `implemented_control`. Exactly one dimension SHALL be
accepted per invocation. When `--corrections-by` is supplied, the report SHALL include an additive
grouping of the repeat-correction and recurrence metrics by that dimension, in both human and
`--json` form. When it is supplied with an unsupported value, or supplied more than once, the
command SHALL fail with an error naming the supported values (or stating exactly one dimension is
supported), SHALL exit non-zero, SHALL write no report output to stdout, and SHALL validate before
any run artifact is read. When the flag is omitted, output SHALL be unchanged and no
grouping-related key SHALL appear.

#### Scenario: grouping by failure class produces one entry per class

- **WHEN** `pipeline scoreboard --corrections-by failure_class --json` is invoked over a window whose corrections span two failure classes
- **THEN** the report SHALL contain a correction-grouping result whose dimension is `failure_class`
- **AND** it SHALL contain exactly one entry per distinct `failure_class`

#### Scenario: an unsupported correction dimension fails without partial output

- **WHEN** `pipeline scoreboard --corrections-by team --json` is invoked
- **THEN** the command SHALL exit non-zero
- **AND** stderr SHALL name the supported dimensions
- **AND** stdout SHALL contain no scoreboard report

#### Scenario: omitting the flag leaves output unchanged

- **WHEN** `pipeline scoreboard --json` is invoked without `--corrections-by`
- **THEN** the parsed JSON object SHALL NOT contain a correction-grouping key
- **AND** the human report SHALL NOT contain a correction-grouping section

### Requirement: Factory scoreboard reports recurrence trends and the top still-recurring classes

When `--bucket` is supplied, each series period SHALL additionally carry its own repeat-correction
totals, so the report shows rolling-window recurrence trends alongside the existing per-period
metrics. Independently of bucketing, the report SHALL include a top-still-recurring-classes list —
the classes with the most post-control recurrence (or, when unattributed, the most in-window
recurrence) — each with sanitized evidence pointers to originating corrections. Every evidence
pointer and excerpt SHALL pass the engine's secret redaction and injection screening before it
appears in any report line or `--json` field.

#### Scenario: bucketed periods carry recurrence totals

- **WHEN** `pipeline scoreboard --bucket day --json` covers a window with corrections on two days
- **THEN** each series period SHALL expose its own repeat-correction totals
- **AND** the per-period totals SHALL sum to the window's total corrections

#### Scenario: top still-recurring classes carry sanitized evidence pointers

- **WHEN** the report lists the top still-recurring correction classes
- **THEN** each listed class SHALL include at least one evidence pointer to an originating correction
- **AND** a pointer or excerpt containing a recognized secret SHALL appear only in redacted form

### Requirement: Factory scoreboard recurrence reporting is read-only and tolerant of bad artifacts

The recurrence and attribution reporting SHALL be read-only: it SHALL invoke no GitHub command,
SHALL NOT create, modify, or delete any file under `.agent-pipeline/runs/`, and SHALL NOT write the
attribution store. Malformed, partial, or old-schema `correction_event` and `control_attribution`
records, and attributions referencing an unknown `correction_key`, SHALL be surfaced as window-level
diagnostics with stable reason codes rather than silently skewing a metric or crashing the scan.

#### Scenario: recurrence reporting mutates nothing

- **WHEN** `pipeline scoreboard` computes recurrence and attribution metrics over a window
- **THEN** no GitHub command SHALL be invoked
- **AND** no file under `.agent-pipeline/runs/` and no attribution store file SHALL be created, modified, or deleted

#### Scenario: malformed correction or attribution record is diagnosed, not fatal

- **WHEN** the scan encounters a malformed or unknown-schema `correction_event` or `control_attribution` record
- **THEN** the report SHALL include a diagnostic with a stable reason code identifying it
- **AND** the remaining recurrence metrics SHALL still be computed and the scan SHALL NOT crash
