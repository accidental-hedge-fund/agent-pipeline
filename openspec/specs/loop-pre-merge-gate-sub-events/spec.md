# loop-pre-merge-gate-sub-events Specification

## Purpose
TBD - created by archiving change loop-pre-merge-gate-sub-events. Update Purpose after archive.
## Requirements
### Requirement: Loop SHALL publish shared progress events for material pre-merge gate outcomes while advance is linked

The durable loop supervisor SHALL append material progress events to the loop
run’s event trail for pre-merge gate sub-steps that occur on a linked advance
run while advance-run linkage is active (`loop_item_advance_linked` for a given
`(item_id, pipeline_run_id)` and before the matching
`loop_item_advance_finished`). Each progress event SHALL use a single shared
progress event kind (`loop_item_progress`, or the single shared progress kind
established by the stage-progress surface if that lands first under a different
name) and SHALL NOT introduce a second long-lived competing progress model.
Each event’s payload SHALL include at least `item_id`, `pipeline_run_id`,
`domain` equal to `pre_merge`, a `step` identifying the gate facet, and a
`status` identifying the outcome. When the absolute advance `events.jsonl` path
is known from linkage, the payload SHALL include that path (field name `events`
or an equivalent absolute events field).

#### Scenario: CI waiting is visible on the loop stream

- **WHEN** a linked advance run enters a pre-merge CI waiting state
- **THEN** the loop event trail SHALL contain a progress event with
  `domain: "pre_merge"`, `step: "ci"`, `status: "waiting"`, and the linked
  `item_id` and `pipeline_run_id`

#### Scenario: CI pass is visible on the loop stream

- **WHEN** a linked advance run records a definitive pre-merge CI pass
- **THEN** the loop event trail SHALL contain a progress event with
  `domain: "pre_merge"`, `step: "ci"`, `status: "pass"`

#### Scenario: CI fail is visible on the loop stream with classification when available

- **WHEN** a linked advance run records a definitive pre-merge CI failure
- **THEN** the loop event trail SHALL contain a progress event with
  `domain: "pre_merge"`, `step: "ci"`, `status: "fail"`
- **AND** when a failure classification or reason class is available on the
  advance side, the progress payload’s `detail` SHALL carry that classification

#### Scenario: OpenSpec archive outcomes are mirrored

- **WHEN** a linked advance run records an OpenSpec archive `gate_result` of
  pass, skipped, or fail
- **THEN** the loop event trail SHALL contain a progress event with
  `domain: "pre_merge"`, `step: "openspec_archive"`, and `status` equal to
  `pass`, `skipped`, or `fail` respectively

#### Scenario: Delta review started and verdict are mirrored

- **WHEN** a linked advance run starts a pre-merge delta review
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "delta_review"` and `status: "started"` (or the first observable
  equivalent if start is only implicit at verdict time)
- **WHEN** the delta review completes with approve
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "delta_review"` and `status: "approve"`
- **WHEN** the delta review completes with needs-attention and blocking findings
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "delta_review"`, `status: "needs_attention"`, and
  `detail.blocking_count` equal to the number of blocking findings when known

#### Scenario: Pre-merge auto-fix lifecycle is mirrored

- **WHEN** a linked advance run attempts a pre-merge auto-fix
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "autofix"` and `status: "attempted"`
- **WHEN** the auto-fix succeeds (fix landed and the subsequent re-review does
  not block)
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "autofix"` and `status: "success"`
- **WHEN** the auto-fix bound is exhausted or the post-fix re-review still blocks
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "autofix"` and `status: "exhausted"`

#### Scenario: Terminal pre-merge blocked or advanced is mirrored

- **WHEN** pre-merge ends blocked for the linked item
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "terminal"`, `status: "blocked"`, and `detail.reason_class` when a
  stable reason class is available
- **WHEN** the item advances out of pre-merge
- **THEN** the loop event trail SHALL contain a progress event with
  `step: "terminal"` and `status: "advanced"`

#### Scenario: Progress joins to the same advance run as linkage

- **WHEN** start linkage published `pipeline_run_id` `554-…` and absolute
  `events` path `…/554-…/events.jsonl` for item `554`
- **AND** a material pre-merge gate outcome occurs on that advance run
- **THEN** the progress event SHALL carry `item_id: "554"`,
  `pipeline_run_id: "554-…"`, and the same absolute `events` path when known

---

### Requirement: Loop progress mirroring SHALL suppress pure CI poll spam

The loop SHALL emit at most one `domain: "pre_merge"`, `step: "ci"`,
`status: "waiting"` progress event for a single continuous CI waiting stretch on
a linked advance run. Subsequent identical waiting observations from advance
polling SHALL NOT append additional waiting progress events. A later definitive
`pass` or `fail` (or a new waiting stretch after a non-waiting status) MAY emit
new progress events.

#### Scenario: Multiple waiting polls produce one waiting progress line

- **WHEN** the advance stream records CI still pending on three consecutive polls
  without an intervening pass or fail
- **THEN** the loop event trail SHALL contain exactly one `step: "ci"` /
  `status: "waiting"` progress event for that stretch

#### Scenario: Waiting then fail still emits fail

- **WHEN** a waiting progress event was already emitted for the stretch
- **AND** a definitive CI fail is later observed
- **THEN** the loop event trail SHALL still contain a `step: "ci"` /
  `status: "fail"` progress event

---

### Requirement: Progress mirroring SHALL be idempotent per logical outcome for a linkage

The mirror SHALL NOT append a duplicate progress event with the same `step`,
`status`, and outcome fingerprint for a given `(item_id, pipeline_run_id)`
linkage when replaying or re-reading the same advance event that already
produced a progress line. A distinct later outcome (different status or a new
attempt with a distinct fingerprint) SHALL still emit.

#### Scenario: Re-read of the same gate_result does not duplicate

- **WHEN** the mirror has already emitted `openspec_archive` / `pass` for a
  linkage after observing an advance `gate_result`
- **AND** the helper re-reads that same advance line
- **THEN** the loop event trail SHALL NOT gain a second identical
  `openspec_archive` / `pass` progress event for that linkage

---

### Requirement: Progress mirroring SHALL NOT alter pre-merge gate behavior

Publishing loop progress events SHALL be observability-only. The mirror SHALL
NOT change CI gate decisions, OpenSpec archive outcomes, delta review verdicts,
auto-fix eligibility or bounds, blocker labels, or merge/ready-to-deploy policy.

#### Scenario: Mirror failure does not block advance

- **WHEN** appending a loop progress event fails (I/O error on the loop store)
- **THEN** the advance run’s pre-merge logic SHALL continue as it would without
  the mirror
- **AND** the failure SHALL be best-effort (non-fatal to the child advance),
  consistent with other loop event write best-effort patterns

---

### Requirement: Unit tests SHALL cover emit conditions with injected advance outcomes

The implementation SHALL provide unit tests that inject advance event / gate
outcome seams (no real network, git, or subprocess) and prove emit conditions
for: CI waiting (once), CI pass, CI fail (with classification when provided),
OpenSpec archive pass/skipped/fail, delta review approve and needs-attention
(with blocking count), auto-fix attempted/success/exhausted, and terminal
blocked/advanced. At least one test SHALL fail if waiting is emitted once per
poll without spam control.

#### Scenario: Injected gate outcomes drive progress events

- **WHEN** a unit test feeds a fake advance event sequence containing an
  OpenSpec archive pass and a CI fail for a linked item
- **THEN** the recorded loop events SHALL include the corresponding
  `openspec_archive`/`pass` and `ci`/`fail` progress payloads with the expected
  join keys

#### Scenario: Regression bites per-poll waiting spam

- **WHEN** the spam-control is absent and a test feeds three identical CI
  waiting observations
- **THEN** a regression assertion that requires exactly one waiting progress
  event SHALL fail

