# loop-blocked-item-hold-continuation Specification

## Purpose
TBD - created by archiving change loop-blocked-item-hold-continuation. Update Purpose after archive.
## Requirements
### Requirement: An already-blocked dispatched item SHALL be held per-item, never a run-fatal engine defect

The supervisor SHALL record a dispatched item as a per-item **needs-human hold** — never
classify it under the `workflow-engine-defect` blocker class and never record a `run_fatal`
or `human_authority` run stop for it — when, on live truth, the item is observed carrying
the `pipeline:blocked` label, the dispatch made no stage transition, and the dispatch
neither crashed nor was rejected. Detection of the `pipeline:blocked` disposition SHALL use
the **presence** of that label in the item's observed live label set, independent of any
co-present `pipeline:*` stage label and independent of the single-winner stage value derived
for the item; a `pipeline:blocked` label co-present with any other `pipeline:*` stage label
SHALL still be detected. A `pipeline:blocked` label whose recorded reason is absent, empty,
or otherwise unrecoverable (a stale or orphaned blocker) SHALL be dispositioned identically
to any other `pipeline:blocked` label — a needs-human hold — because its remediation is
identical: a human clears the label and the run resumes. The disposition SHALL be a
deterministic function of the observed live labels and the pre/post-dispatch label-add
history, so a unit test drives it with no real network, git, or subprocess call. A genuine
engine defect — a rejected or crashed dispatch, or an unrecognized terminal outcome with the
item at no `pipeline:blocked` state — SHALL remain classified `workflow-engine-defect` with
its `run_fatal` policy unchanged.

#### Scenario: A stale co-present blocked label becomes a hold, not a run-fatal defect

- **WHEN** a dispatched item is observed carrying `pipeline:blocked` co-present with a
  `pipeline:*` stage label, the dispatch made zero stage transitions, and the dispatch
  neither crashed nor was rejected
- **THEN** the supervisor SHALL record the item as a per-item needs-human hold
- **AND** it SHALL NOT classify the item under `workflow-engine-defect`
- **AND** it SHALL NOT record a `run_fatal` or `human_authority` run stop

#### Scenario: A reason-less blocker is dispositioned like any blocker

- **WHEN** the observed `pipeline:blocked` label carries no recoverable reason (a stale,
  orphaned audit-repair placeholder)
- **THEN** the supervisor SHALL record the item as a per-item needs-human hold exactly as it
  would for a `pipeline:blocked` label carrying a reason
- **AND** it SHALL NOT treat the missing reason as a genuine engine defect

#### Scenario: Presence detection does not depend on the stage-winner

- **WHEN** the item's single-winner pipeline stage value derived from its labels is a value
  other than `blocked`, yet `pipeline:blocked` is present in the same label set
- **THEN** the supervisor SHALL detect the `pipeline:blocked` disposition from the label's
  presence and route the item to the needs-human hold
- **AND** it SHALL NOT fall through to `workflow-engine-defect` because `blocked` was not the
  stage-winner

#### Scenario: A genuine engine defect is still run-fatal

- **WHEN** a dispatch is rejected or crashes, or reports an outcome outside the defined
  terminal set with the item at no `pipeline:blocked` state
- **THEN** the outcome SHALL be classified `workflow-engine-defect`
- **AND** its existing `run_fatal` policy SHALL apply unchanged

---

### Requirement: A per-item needs-human hold SHALL NOT terminate a run that still has schedulable work

A per-item needs-human hold SHALL NOT, on its own, terminate the run. While at least one
other item can make progress, the supervisor SHALL exclude each held (`paused`/`waiting`)
item from the executable frontier — re-evaluated against the fresh reconciliation each
cycle, so a hold cleared by a human re-enters the frontier **only when no host-local advance
is still live for that item** — and SHALL continue selecting and dispatching the remaining
schedulable items. Clearing GitHub `pipeline:blocked` alone SHALL NOT re-admit an item into
the executable dispatch frontier while a live linked advance (or other host-local live-advance
evidence) for that item is non-terminal; in that case the item SHALL remain excluded from
full re-dispatch until the live advance is proven terminal or the live-advance probe reports
not live, and a durable record SHALL distinguish that deferred re-admission from an
unconditional hold clear. The supervisor SHALL reach its terminal outstanding-hold condition —
pausing and reporting `hold_outstanding=true` — only when no non-done item can make
progress: every remaining item is held or blocked and no schedulable item remains. When it
reaches that terminal outstanding-hold condition, the supervisor SHALL enumerate every held
item id in both the durable record and the `pipeline loop` command output, so an operator
sees exactly which items await a human. This enumeration SHALL be additive disclosure on the
existing terminal condition — it SHALL NOT introduce a new stop reason, alter which items
are considered done, or weaken the existing no-progress watchdog.

#### Scenario: A hold does not strand schedulable siblings

- **WHEN** one dispatched item is held for a needs-human blocker and one or more other items
  are schedulable
- **THEN** the run SHALL continue dispatching the schedulable items
- **AND** the run SHALL NOT reach a terminal condition solely because one item is held

#### Scenario: One blocked item plus N clean items dispatches the clean items

- **WHEN** a work-list contains one item already carrying `pipeline:blocked` and N clean,
  schedulable items
- **THEN** the supervisor SHALL hold the blocked item and dispatch the N clean items to their
  outcomes
- **AND** the run SHALL NOT record a `run_fatal` run stop for the blocked item

#### Scenario: The run pauses only when nothing can progress

- **WHEN** every remaining non-done item is held or blocked and no schedulable item remains
- **THEN** the supervisor SHALL reach its terminal outstanding-hold condition and report
  `hold_outstanding=true`
- **AND** the terminal report SHALL enumerate every held item id in the durable record and
  the `pipeline loop` output

#### Scenario: A held item re-enters the frontier when a human clears it and no advance is live

- **WHEN** a held item's `pipeline:blocked` label is cleared by a human between cycles
- **AND** no host-local advance is live for that item (no live lock, no non-terminal run-store,
  no non-terminal loop linkage)
- **THEN** the next reconciliation SHALL observe the item as no longer held for dispatch
- **AND** the supervisor SHALL re-admit it to the executable frontier rather than leaving it
  excluded

#### Scenario: Clearing blocked while a live advance exists does not re-admit for full dispatch

- **WHEN** a held item's `pipeline:blocked` label is cleared by a human between cycles
- **AND** a host-local advance is still live for that item (live lock, non-terminal run-store,
  or non-terminal loop linkage)
- **THEN** the supervisor SHALL NOT re-admit the item into a second full advance dispatch
- **AND** it SHALL NOT record a fatal double-dispatch failure for that item
- **AND** a durable record SHALL show that re-admission was deferred for coexistence rather
  than treating the item as unconditionally cleared for dispatch

### Requirement: Schedule next_actions SHALL NOT advertise advance for GitHub-blocked items without an unblock path

The durable loop schedule SHALL NOT present an actionable `advance` disposition in `next_actions`
for an item whose live labels include `pipeline:blocked` (including when a stage label co-presents)
when no unblock path has cleared that blocker. The action SHALL be a hold / waiting /
unblock-oriented disposition consistent with the per-item needs-human hold model, until a human
clears `pipeline:blocked` or an audited unblock path applies. This requirement is additive
disclosure and schedule hygiene: it SHALL NOT weaken run-fatal classification for genuine engine
defects, and SHALL NOT clear or rewrite GitHub labels on its own.

#### Scenario: Blocked pre-merge item is not next_actions advance

- **WHEN** live labels for an item include `pipeline:blocked` after a pre-merge needs-human
  escalation
- **AND** no unblock path has cleared that label
- **THEN** reconciliation `next_actions` for that item SHALL NOT be an actionable `advance`
- **AND** the disposition SHALL indicate the item is held awaiting human unblock (or equivalent
  non-dispatchable state)

#### Scenario: Cleared blocker can become advanceable again

- **WHEN** a previously blocked item no longer carries `pipeline:blocked` on live truth and is
  otherwise schedulable
- **THEN** reconciliation MAY assign an `advance` (or other progressive) next action under the
  existing scheduler rules

#### Scenario: Engine defects remain run-fatal when applicable

- **WHEN** a dispatch is rejected or crashes without a `pipeline:blocked` disposition
- **THEN** existing `workflow-engine-defect` / `run_fatal` policy SHALL apply unchanged

### Requirement: Hold-clear reconciliation SHALL consult live-advance evidence before frontier re-admission

The hold-clear path that reopens needs-human holds after `pipeline:blocked` disappears SHALL
consult the same host-local live-advance probe (and any non-terminal loop advance linkage)
used by loop live-advance coexistence before moving an item to `pending` for full dispatch.
Label absence remains necessary for re-admission and is not sufficient while live evidence
exists. This requirement composes with, and does not weaken, the presence-based needs-human
hold model or the non-run-fatal continuation of schedulable siblings.

#### Scenario: Live operator advance blocks re-admit after unblock

- **WHEN** item `675` is held with source `pipeline_blocked_label`
- **AND** an operator clears `pipeline:blocked` while a separate host-local `/pipeline 675`
  advance is still live
- **THEN** hold-clear reconciliation SHALL NOT move `675` to an executable full-dispatch
  frontier state that starts a second advance
- **AND** the multi-item run SHALL NOT stop with `run_fatal` solely because of that coexistence

#### Scenario: Terminal live advance then allows re-admit

- **WHEN** item `675` had re-admission deferred because an advance was live
- **AND** a later cycle proves that advance terminal and `pipeline:blocked` remains absent
- **THEN** the supervisor MAY re-admit `675` under ordinary scheduler rules
- **AND** a subsequent dispatch, if any, is not classified as coexistence solely for the prior
  live period

