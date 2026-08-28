# train-event-stream Specification

## Purpose
Gives every `pipeline train` invocation a durable train-level run ID and an append-only `events.jsonl` in the generic run-store layout so hosts can follow and filter train with existing `pipeline logs` and the shared material filter.

## Requirements

### Requirement: Train SHALL mint a durable train-level run ID and generic run-store directory

Train SHALL create a run directory under the generic run-store root `.agent-pipeline/runs/<train-run-id>/` before the first advance wave for each admitted live (non-`--dry-run`) `pipeline train` invocation. The run ID SHALL use a `train-` prefix and a filesystem-safe UTC timestamp with millisecond precision so it cannot collide with per-issue advance IDs of the form `<issue>-<timestamp>`. The directory SHALL contain `events.jsonl` (append-only) in the same layout `pipeline logs` already reads. `run.json` SHALL identify the run as a train (selector and merge mode, plus ordered issues when known) and SHALL NOT present a single work-list issue as if this were a one-issue advance run. A missing selector that the command already refuses SHALL NOT create a run directory. A `--dry-run` invocation SHALL NOT create a train run directory, even when the selector is valid.

#### Scenario: Train run directory exists before the first wave

- **WHEN** `pipeline train --issues 10,11` is admitted and begins work
- **THEN** `.agent-pipeline/runs/train-<timestamp>/events.jsonl` SHALL exist before the first advance-wave call
- **AND** the basename SHALL start with `train-`
- **AND** it SHALL NOT equal an advance run id of the form `10-<timestamp>`

#### Scenario: run.json is not a fake single-issue advance record

- **WHEN** a train run directory is initialized for issues 10 and 11
- **THEN** `run.json` SHALL mark the run as a train
- **AND** it SHALL NOT set `issue` solely to `10` as the run's identity the way an advance run for issue 10 does

#### Scenario: Refused selector creates no run

- **WHEN** `pipeline train` is invoked with neither `--issues` nor `--milestone`
- **THEN** the command SHALL exit non-zero as it does today
- **AND** it SHALL NOT create a train run directory

#### Scenario: Dry-run creates no run

- **WHEN** `pipeline train --issues 10,11 --dry-run` is admitted and prints a plan
- **THEN** the command SHALL NOT create a train run directory
- **AND** it SHALL NOT write `events.jsonl`

### Requirement: Train SHALL flush an early train_run_handoff on stderr

Train SHALL flush one JSON line on stderr whose `kind` is `train_run_handoff` after the train run directory exists and `events.jsonl` is readable, and before the first advance wave. That object SHALL include `schema_version`, `run_id`, `run_dir`, and the absolute `events` path. A host SHALL be able to parse `run_id` and `events` from that line without scraping prose. That object SHALL NOT be written to `train --json` stdout. Existing per-wave `loop_run_handoff` stderr lines SHALL remain.

#### Scenario: Handoff is available before the first wave

- **WHEN** a train starts and the run store is initialized
- **THEN** stderr SHALL contain one JSON line with `kind` equal to `train_run_handoff`
- **AND** that object SHALL include `run_id` and an absolute `events` path
- **AND** the first advance-wave call SHALL not have started before that line is flushed

#### Scenario: Handoff does not share --json stdout

- **WHEN** `pipeline train --json` emits `train_run_handoff` on stderr
- **THEN** stdout SHALL still parse as exactly one `train_status` object
- **AND** that stdout SHALL NOT contain a `train_run_handoff` object

### Requirement: Train events SHALL use a versioned generic-run-store envelope

Train event lines SHALL be complete JSON objects that carry `schema_version` (integer `1`), monotonic `seq` (1-based integer, increasing by one per appended train event), `type` (event kind string), `at` (ISO-8601 UTC timestamp), and `run_id` (the train run ID). An event about one issue SHALL include that issue number. An event about one pull request SHALL include that PR number. Lines SHALL be written through the same `appendEvent` chokepoint as other generic run-store events (redaction, sink, write-health, non-fatal I/O). Readers SHALL preserve unknown fields. `schema_version` SHALL remain `1`.

#### Scenario: Envelope fields are present on a work-list event

- **WHEN** train appends `train_work_list_resolved`
- **THEN** the JSON line SHALL contain `schema_version` equal to `1`, integer `seq`, `type` equal to `train_work_list_resolved`, ISO-8601 `at`, and the train `run_id`

#### Scenario: Item events carry issue identity

- **WHEN** train appends `train_item_started` for issue 11
- **THEN** that line SHALL include issue identity `11`
- **AND** SHALL include the same train `run_id` as `run_start`

#### Scenario: Sequence is monotonic

- **WHEN** a train appends three events
- **THEN** their `seq` values SHALL be `1`, `2`, and `3` in file order

### Requirement: Train SHALL emit the closed material event catalog

The train stream SHALL append these `type` values at the corresponding train lifecycle points:

- `run_start` at store init
- `train_work_list_resolved` when the ordered issue list is known (payload includes that ordered list)
- `train_wave_started` when an advance wave begins (payload includes the frontier issue numbers)
- `train_loop_linked` when that wave's loop run ID is known and the loop store is confirmed (payload includes `loop_run_id` and the absolute loop `events.jsonl` path when known)
- `train_item_started` when a work-list issue begins train work
- `train_item_completed` when that issue reaches a train terminal (`ready-to-deploy`, `needs-human`, `blocked`, `already-integrated`, `error`, `parked`, or `dependency-skipped`)
- `train_pr_created` when train observes a linked PR number for an item
- `train_merge_attempted` when merge-mode invokes a merge mutation
- `train_merge_proven` when merge-result containment in the fetched base is proven
- `train_merge_integrated` when the item counts as integrated, including an already-integrated skip
- `train_sibling_halted` when an item is held or parked while proven-independent siblings continue, including in `--merge` mode after a contained hold
- `train_wave_ended` when that advance wave returns
- `run_complete` when the train process finishes (see terminal requirement)

Train SHALL NOT copy child loop, advance, CI, harness, or compiler stdout into this stream. Non-merge trains SHALL NOT emit merge-attempted/proven/integrated events. `train_loop_linked` SHALL be omitted when no live loop store is confirmed; train SHALL NOT invent an absolute events path that points at a missing directory.

#### Scenario: Work list and wave bounds are recorded

- **WHEN** a merge-off train resolves issues 10 then 11 and runs one advance wave for both
- **THEN** `events.jsonl` SHALL contain `train_work_list_resolved` with ordered issues `[10, 11]`
- **AND** SHALL contain `train_wave_started` whose frontier includes 10 and 11
- **AND** SHALL contain `train_wave_ended` for that wave

#### Scenario: Merge-mode records attempted, proven, and integrated

- **WHEN** a `--merge` train merges PR 20 for issue 10 and proves containment
- **THEN** `events.jsonl` SHALL contain `train_merge_attempted` for issue 10 and PR 20
- **AND** SHALL contain `train_merge_proven` with the merge-result identity
- **AND** SHALL contain `train_merge_integrated` for issue 10

#### Scenario: Sibling halt is recorded without aborting independents

- **WHEN** issue 10 is parked and proven-independent issue 11 continues
- **THEN** `events.jsonl` SHALL contain `train_sibling_halted` naming issue 10
- **AND** later events MAY still record work on issue 11

#### Scenario: Merge-mode contained hold records sibling halt then independent work

- **WHEN** a `--merge` train holds issue 268 after a contained block or wait
- **AND** independent issue 267 continues
- **THEN** `events.jsonl` SHALL contain `train_sibling_halted` naming 268
- **AND** later events SHALL still record work on 267
- **AND** the stream SHALL NOT end at the hold of 268 as if the train had abandoned 267

#### Scenario: Dependency-skipped terminal is recorded

- **WHEN** issue 270 is skipped because it depends on held issue 268
- **THEN** `events.jsonl` SHALL contain `train_item_completed` for 270 whose terminal is `dependency-skipped`

#### Scenario: Missing loop store does not fabricate linkage

- **WHEN** an advance wave returns without a confirmed loop `events.jsonl`
- **THEN** train SHALL NOT append `train_loop_linked` that presents a live path to a missing file

#### Scenario: Raw child output stays off the train stream

- **WHEN** a wave's compiler or CI stdout contains `/training` or `0 errors`
- **THEN** the train `events.jsonl` SHALL NOT contain those lines as event payloads
- **AND** that output SHALL remain on the linked wave or advance logs when those logs exist

### Requirement: Train SHALL link each confirmed wave loop run from the train stream

Train SHALL append `train_loop_linked` when an advance wave is driven by the durable loop and the loop run store is confirmed. That event SHALL include at least the train `run_id`, the wave identity, the real loop `run_id`, and the absolute loop `events.jsonl` path when known. A host that follows only the train stream SHALL be able to invoke `pipeline loop logs <loop-run-id> --events` (or open that absolute path) without scanning state-home directories by mtime. Synthetic `pipeline-loop-…` strings SHALL NOT be the only join key when a real loop run ID is known.

#### Scenario: Host drills into the wave from train events alone

- **WHEN** train links loop run `abc` with absolute events path `E` for a wave
- **THEN** a consumer reading only the train `events.jsonl` SHALL obtain loop run id `abc` and path `E`
- **AND** it SHALL NOT need to scrape `loop_run_handoff` prose to find that wave

#### Scenario: Real loop id is required when the store exists

- **WHEN** the wave's loop directory basename is `2026-08-28T17-28-03-000Z`
- **THEN** `train_loop_linked.loop_run_id` SHALL equal that basename
- **AND** SHALL NOT equal only a synthetic `pipeline-loop-…` string

### Requirement: Train SHALL end the stream with type run_complete

Train SHALL append a JSON line with `type` equal to `run_complete` on every process exit that is not an abrupt crash after the train run store exists, so `pipeline logs <train-run-id> --events --follow` can end under the existing until-terminal default. That event SHALL include `final_state` and `elapsed_ms`. It MAY include additive summary fields (complete flag, blocker, item counts). It SHALL be written for successful completion and for STOP/hold/error exits after init. Train SHALL NOT rely on a train-only terminal kind as the only stop event. `schema_version` SHALL remain `1`.

#### Scenario: Happy-path follow exits on run_complete

- **WHEN** a train completes successfully
- **THEN** its `events.jsonl` SHALL contain a line with `type` equal to `run_complete`
- **AND** `pipeline logs <train-run-id> --events --follow` under the until-terminal default SHALL print that line and exit 0

#### Scenario: STOP after init still writes run_complete

- **WHEN** a train initializes its run store and then STOPs with a blocker
- **THEN** `events.jsonl` SHALL still contain `type` equal to `run_complete`
- **AND** the event MAY include the blocker as an additive field

### Requirement: Existing pipeline logs SHALL be the host follow interface for train

The CLI SHALL dump or follow a train run with `pipeline logs <train-run-id> [--events] [--follow | -f] [--until-terminal | --no-until-terminal]`. The CLI SHALL NOT add a `pipeline train logs` command for this capability. Until-terminal SHALL keep using `type: "run_complete"` (no train-specific logs predicate). `pipeline logs` with no run-id SHALL list train run IDs among other generic run-store IDs. Observation SHALL remain read-only and SHALL NOT hold a run-liveness lock.

#### Scenario: logs --events prints the train file

- **WHEN** `pipeline logs <train-run-id> --events` is invoked without `--follow`
- **THEN** the full current contents of that train run's `events.jsonl` SHALL be printed
- **AND** the process SHALL exit 0

#### Scenario: No train logs subcommand is added

- **WHEN** an operator inspects CLI help for train observation
- **THEN** the documented follow command SHALL be `pipeline logs <train-run-id> --events --follow`
- **AND** it SHALL NOT require `pipeline train logs`

### Requirement: Train events SHALL be observational and SHALL NOT change train mutations

Train SHALL treat event emission and host notify delivery as observational: they SHALL NOT grant merge or advance authority and SHALL NOT change train scheduling, merge, or park outcomes. A failed append is non-fatal per `appendEvent` write-health law. A host that never follows the stream SHALL still get the same merge and advance mutations.

#### Scenario: Notify failure does not stop merge

- **WHEN** a train-merge mutation is eligible and no host is following `events.jsonl`
- **THEN** train SHALL still invoke the merge surface under existing merge-mode law
- **AND** missing notify SHALL NOT be a blocker

### Requirement: Unit tests SHALL cover train events through injected seams

The implementation SHALL provide unit tests that inject train, run-store, and wave seams (no real network, git, or subprocess) and that fail if: no train-level `events.jsonl` is written before the first wave; the published run ID is not the generic-store basename; a confirmed wave loop run ID is omitted from `train_loop_linked`; `run_complete` is missing on a normal STOP/complete exit; `train --json` stdout contains `train_run_handoff` or extra JSON objects; or `run.json` looks like a single-issue advance run. At least one regression SHALL fail against today's stdout-only train without the store.

#### Scenario: Missing events file fails the suite

- **WHEN** a hermetic train fixture completes two issues and no train-level `events.jsonl` exists
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Missing loop linkage fails the suite

- **WHEN** a hermetic fixture drives an advance wave that reports a confirmed loop run id and events path
- **AND** the train stream has no `train_loop_linked` with that id
- **THEN** the test SHALL fail
