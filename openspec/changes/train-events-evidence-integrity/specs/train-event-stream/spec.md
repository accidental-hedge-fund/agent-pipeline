## ADDED Requirements

### Requirement: Train SHALL publish train_loop_linked from the child onRunReady handoff

Train SHALL append `train_loop_linked` from the child loop's typed `onRunReady` handoff after the loop store and the exact events path exist, and before that child can block on work. The event SHALL include the train `run_id`, the wave identity, the exact child loop `run_id`, and the absolute loop `events.jsonl` path from that handoff. Train SHALL emit each live linkage once. A later wave result MAY confirm the same identity. It SHALL NOT append a second `train_loop_linked` for that identity and SHALL NOT replace the live identity with a guessed run, a latest-run lookup, or a synthetic `pipeline-loop-…` string. Train SHALL NOT scrape stdout or stderr prose to mint the link.

#### Scenario: Live child is followable before it is terminal

- **WHEN** a train advance wave starts a child loop that remains blocked or otherwise live
- **AND** that child has fired `onRunReady` with run id `abc` and absolute events path `E`
- **THEN** the train `events.jsonl` SHALL contain `train_loop_linked` with `loop_run_id` equal to `abc` and `events` equal to `E`
- **AND** that line SHALL exist before the child loop reaches a terminal state
- **AND** that line SHALL exist before `advanceWave` returns

#### Scenario: Duplicate handoff does not append a second link

- **WHEN** train has already appended `train_loop_linked` for loop run `abc` from `onRunReady`
- **AND** the later wave result reports the same loop run `abc`
- **THEN** the train stream SHALL contain exactly one `train_loop_linked` for `abc`
- **AND** that event SHALL keep the original `loop_run_id` and events path

#### Scenario: Wave result MUST NOT guess a different run

- **WHEN** train has already linked loop run `abc` from `onRunReady`
- **AND** a later result would present a different or synthetic loop id
- **THEN** train SHALL keep `abc`
- **AND** SHALL NOT append a replacement `train_loop_linked`

#### Scenario: Conflicting later handoff degrades evidence and keeps the first link

- **WHEN** train has already linked loop run `abc` and events path `E` from `onRunReady`
- **AND** a later handoff reports a different loop run `xyz` and path `F`
- **THEN** the train stream SHALL keep the first `train_loop_linked` for `abc` and `E`
- **AND** SHALL NOT append a second `train_loop_linked`
- **AND** `train_status.events_coverage` SHALL equal `degraded`
- **AND** the wave result, merge decisions, retry behavior, and exit status SHALL be unchanged

### Requirement: Train SHALL allocate run identity with exclusive publication

Train SHALL publish each live (non-`--dry-run`) train run directory with an exclusive create of `.agent-pipeline/runs/<train-run-id>/` using non-recursive `mkdir`. The base run ID SHALL remain `train-` plus the filesystem-safe UTC timestamp with millisecond precision. Train SHALL retry a suffix only when exclusive create fails with `EEXIST`. The suffix sequence SHALL be `train-<timestamp>-2` through `train-<timestamp>-8` (eight exclusive attempts including the unsuffixed id). Two starts that share one clock instant SHALL receive distinct run IDs and isolated `events.jsonl` sequences. Exclusive allocation and `initRunDir` SHALL remain observational. Train SHALL NOT treat a colliding train directory as idempotent re-entry of a different train. Train SHALL NOT write `run.json`, `events.jsonl`, or `write-health.json` under a directory whose exclusive create failed. Advance issue-prefixed `initRunDir` resume SHALL NOT change. A non-`EEXIST` exclusive-create error SHALL NOT retry a suffix, SHALL set `events_coverage` to `unknown`, SHALL create no store, and SHALL NOT change advance or merge mutations or exit status.

#### Scenario: Same-clock trains get distinct stores

- **WHEN** two admitted live trains start with the same injected timestamp
- **THEN** each train SHALL receive a distinct run ID whose basename starts with `train-`
- **AND** each train SHALL append only to its own `events.jsonl`
- **AND** neither `seq` stream SHALL contain the other train's events

#### Scenario: Collision suffix keeps the train prefix

- **WHEN** `train-<timestamp>` already exists and allocation retries
- **THEN** the published basename SHALL start with `train-`
- **AND** it SHALL NOT equal an advance run id of the form `<issue>-<timestamp>`

#### Scenario: EEXIST retries a suffix and does not write the colliding directory

- **WHEN** exclusive create of `train-<timestamp>` fails with `EEXIST`
- **AND** exclusive create of `train-<timestamp>-2` succeeds
- **THEN** train SHALL open the store only under `train-<timestamp>-2`
- **AND** SHALL NOT write `run.json`, `events.jsonl`, or `write-health.json` under `train-<timestamp>`

#### Scenario: Non-EEXIST exclusive create does not suffix-retry

- **WHEN** exclusive create of `train-<timestamp>` fails with `EACCES` or any error other than `EEXIST`
- **THEN** train SHALL NOT retry `train-<timestamp>-2`
- **AND** `events_coverage` SHALL equal `unknown`
- **AND** train SHALL create no run store
- **AND** advance, merge, retry, and exit status SHALL be unchanged

### Requirement: Exhausted train identity allocation SHALL degrade evidence and continue

When exclusive allocation cannot publish a unique train run directory within the bounded retry set, train SHALL report typed train-event coverage of `degraded` or `unknown` on the existing `train_status` object, SHALL NOT create or append to an ambiguous shared store, SHALL NOT flush `train_run_handoff` for a colliding id, and SHALL continue the same advance and merge mutations it would have performed with a store. Missing events SHALL NOT grant or deny merge or advance authority.

#### Scenario: Exhausted allocation creates no shared store

- **WHEN** every exclusive run-directory attempt for a live train collides or fails
- **THEN** train SHALL NOT write `run.json` or `events.jsonl` under a colliding `train-*` directory
- **AND** `train_status` SHALL include `events_coverage` equal to `degraded` or `unknown`
- **AND** `train_status` SHALL omit `run_id`
- **AND** stderr SHALL NOT contain `train_run_handoff` for a shared id

#### Scenario: Exhausted allocation does not change mutations

- **WHEN** identity allocation is exhausted for a `--merge` train of issues 10 and 11
- **THEN** train SHALL still advance and merge the same issues under existing train law
- **AND** the missing event stream SHALL NOT be a blocker

### Requirement: Train merge proof SHALL name newly-merged or already-contained disposition

When merge-mode proves that a merge-result is contained in the fetched base, train SHALL append `train_merge_proven` whether the item was newly merged in this run or was already contained. That event SHALL include an additive `proof_disposition` of `newly-merged` or `already-contained`. Both paths SHALL still append `train_merge_integrated`. Event absence SHALL NOT be the only signal that the item was already contained. Non-merge trains SHALL NOT emit these merge events. `schema_version` SHALL remain `1`.

#### Scenario: Newly merged item emits proven with newly-merged disposition

- **WHEN** a `--merge` train merges PR 20 for issue 10 and proves containment
- **THEN** `events.jsonl` SHALL contain `train_merge_proven` for issue 10 and PR 20 whose `proof_disposition` is `newly-merged`
- **AND** SHALL contain `train_merge_integrated` for issue 10

#### Scenario: Already-contained item emits proven with already-contained disposition

- **WHEN** a `--merge` train reconciles issue 10 as already integrated because its linked PR is merged and the merge-result is contained in the fetched base
- **THEN** `events.jsonl` SHALL contain `train_merge_proven` for issue 10 whose `proof_disposition` is `already-contained`
- **AND** SHALL contain `train_merge_integrated` for issue 10
- **AND** SHALL NOT omit `train_merge_proven` solely because no merge mutation ran

#### Scenario: Proven precedes integrated and keeps proof_disposition off integrated

- **WHEN** a `--merge` train emits both `train_merge_proven` and `train_merge_integrated` for the same issue
- **THEN** `train_merge_proven` SHALL appear before `train_merge_integrated` for that issue
- **AND** `proof_disposition` SHALL be present on `train_merge_proven`
- **AND** `proof_disposition` SHALL be absent from `train_merge_integrated`

### Requirement: Train event observation failures SHALL NOT change mutations or exit status

A failed `train_loop_linked` append, a failed exclusive allocation, and a failed event-store init SHALL degrade `events_coverage` and SHALL NOT abort the wave, change merge decisions, change retry behavior, or change exit status. After a published store, a failed `train_loop_linked` append SHALL leave `run_id` set and SHALL set `events_coverage` to `degraded`.

#### Scenario: Failed live-link append degrades coverage and continues

- **WHEN** a train run store is published
- **AND** appending `train_loop_linked` fails
- **THEN** `events_coverage` SHALL equal `degraded`
- **AND** `run_id` SHALL remain the published train id
- **AND** the wave result and exit status SHALL be unchanged

## MODIFIED Requirements

### Requirement: Train SHALL mint a durable train-level run ID and generic run-store directory

Train SHALL create a run directory under the generic run-store root `.agent-pipeline/runs/<train-run-id>/` before the first advance wave for each admitted live (non-`--dry-run`) `pipeline train` invocation whose identity allocation succeeds. The run ID SHALL use a `train-` prefix and a filesystem-safe UTC timestamp with millisecond precision so it cannot collide with per-issue advance IDs of the form `<issue>-<timestamp>`. Concurrent same-clock starts SHALL NOT share one directory; allocation SHALL use exclusive publication and a bounded suffix as specified by exclusive train identity allocation. The directory SHALL contain `events.jsonl` (append-only) in the same layout `pipeline logs` already reads. `run.json` SHALL identify the run as a train (selector and merge mode, plus ordered issues when known) and SHALL NOT present a single work-list issue as if this were a one-issue advance run. A missing selector that the command already refuses SHALL NOT create a run directory. A `--dry-run` invocation SHALL NOT create a train run directory, even when the selector is valid. Exhausted exclusive allocation SHALL follow the degradation requirement and SHALL NOT open a colliding directory as if it were this invocation's store.

#### Scenario: Train run directory exists before the first wave

- **WHEN** `pipeline train --issues 10,11` is admitted and begins work
- **AND** exclusive identity allocation succeeds
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

Train SHALL flush one JSON line on stderr whose `kind` is `train_run_handoff` after the train run directory exists and `events.jsonl` is readable, and before the first advance wave, when exclusive identity allocation succeeded. That object SHALL include `schema_version`, `run_id`, `run_dir`, and the absolute `events` path. A host SHALL be able to parse `run_id` and `events` from that line without scraping prose. That object SHALL NOT be written to `train --json` stdout. Existing per-wave `loop_run_handoff` stderr lines SHALL remain. When exclusive allocation is exhausted, train SHALL NOT flush a `train_run_handoff` that names a shared or colliding run directory.

#### Scenario: Handoff is available before the first wave

- **WHEN** a train starts and the run store is initialized
- **THEN** stderr SHALL contain one JSON line with `kind` equal to `train_run_handoff`
- **AND** that object SHALL include `run_id` and an absolute `events` path
- **AND** the first advance-wave call SHALL not have started before that line is flushed

#### Scenario: Handoff does not share --json stdout

- **WHEN** `pipeline train --json` emits `train_run_handoff` on stderr
- **THEN** stdout SHALL still parse as exactly one `train_status` object
- **AND** that stdout SHALL NOT contain a `train_run_handoff` object

#### Scenario: Exhausted allocation omits handoff for a shared id

- **WHEN** exclusive train identity allocation is exhausted
- **THEN** stderr SHALL NOT contain a `train_run_handoff` object whose `run_id` names a colliding directory
- **AND** stdout SHALL still parse as exactly one `train_status` object

### Requirement: Train SHALL emit the closed material event catalog

The train stream SHALL append these `type` values at the corresponding train lifecycle points:

- `run_start` at store init
- `train_work_list_resolved` when the ordered issue list is known (payload includes that ordered list)
- `train_wave_started` when an advance wave begins (payload includes the frontier issue numbers)
- `train_loop_linked` from the child `onRunReady` handoff when that wave's loop run ID is known and the loop store is confirmed (payload includes the exact `loop_run_id` and the absolute loop `events.jsonl` path from that handoff)
- `train_item_started` when a work-list issue begins train work
- `train_item_completed` when that issue reaches a train terminal (`ready-to-deploy`, `needs-human`, `blocked`, `already-integrated`, `error`, `parked`, or `dependency-skipped`)
- `train_pr_created` when train observes a linked PR number for an item
- `train_merge_attempted` when merge-mode invokes a merge mutation
- `train_merge_proven` when merge-result containment in the fetched base is proven, including already-contained reconciliation (payload includes `proof_disposition`)
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

Train SHALL append `train_loop_linked` when an advance wave is driven by the durable loop and the loop run store is confirmed by the child `onRunReady` handoff (or by a later confirmation of that same identity). That event SHALL include at least the train `run_id`, the wave identity, the real loop `run_id`, and the absolute loop `events.jsonl` path from that handoff. A host that follows only the train stream SHALL be able to invoke `pipeline loop logs <loop-run-id> --events` (or open that absolute path) without scanning state-home directories by mtime, and SHALL be able to do so while the child is still live. Synthetic `pipeline-loop-…` strings SHALL NOT be the only join key when a real loop run ID is known.

#### Scenario: Host drills into the wave from train events alone

- **WHEN** train links loop run `abc` with absolute events path `E` for a wave
- **THEN** a consumer reading only the train `events.jsonl` SHALL obtain loop run id `abc` and path `E`
- **AND** it SHALL NOT need to scrape `loop_run_handoff` prose to find that wave

#### Scenario: Real loop id is required when the store exists

- **WHEN** the wave's loop directory basename is `2026-08-28T17-28-03-000Z`
- **THEN** `train_loop_linked.loop_run_id` SHALL equal that basename
- **AND** SHALL NOT equal only a synthetic `pipeline-loop-…` string

### Requirement: Train events SHALL be observational and SHALL NOT change train mutations

Train SHALL treat event emission, identity allocation, and host notify delivery as observational: they SHALL NOT grant merge or advance authority and SHALL NOT change train scheduling, merge, or park outcomes. A failed append is non-fatal per `appendEvent` write-health law. A failed exclusive identity allocation is non-fatal per the degradation requirement. A host that never follows the stream SHALL still get the same merge and advance mutations.

#### Scenario: Notify failure does not stop merge

- **WHEN** a train-merge mutation is eligible and no host is following `events.jsonl`
- **THEN** train SHALL still invoke the merge surface under existing merge-mode law
- **AND** missing notify SHALL NOT be a blocker

#### Scenario: Allocation failure does not stop merge

- **WHEN** a train-merge mutation is eligible and exclusive train identity allocation is exhausted
- **THEN** train SHALL still invoke the merge surface under existing merge-mode law
- **AND** missing train events SHALL NOT be a blocker

### Requirement: Unit tests SHALL cover train events through injected seams

The implementation SHALL provide unit tests that inject train, run-store, clock/ID, and wave seams (no real network, git, or subprocess) and that fail if: no train-level `events.jsonl` is written before the first wave when allocation succeeds; the published run ID is not the generic-store basename; a confirmed live `onRunReady` loop run ID is omitted from `train_loop_linked` until the child is terminal; a duplicate handoff appends a second link; two same-clock trains share one run directory or one `seq` stream; exhausted allocation writes a shared store or changes which issues advance or merge; `run_complete` is missing on a normal STOP/complete exit; `train --json` stdout contains `train_run_handoff` or extra JSON objects; `run.json` looks like a single-issue advance run; a newly merged contained item omits `train_merge_proven` with `proof_disposition` `newly-merged`; or an already-contained item omits `train_merge_proven` with `proof_disposition` `already-contained`. At least one regression SHALL fail against today's stdout-only train without the store.

#### Scenario: Missing events file fails the suite

- **WHEN** a hermetic train fixture completes two issues and no train-level `events.jsonl` exists
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Missing loop linkage fails the suite

- **WHEN** a hermetic fixture drives an advance wave that reports a confirmed loop run id and events path
- **AND** the train stream has no `train_loop_linked` with that id
- **THEN** the test SHALL fail

#### Scenario: Late live linkage fails the suite

- **WHEN** a hermetic fixture calls the wave `onLoopReady` / `onRunReady` handoff with a confirmed loop run id and events path and leaves the wave promise unresolved
- **AND** the train stream has no `train_loop_linked` with that id before the child is terminal
- **THEN** the test SHALL fail

#### Scenario: Shared same-clock store fails the suite

- **WHEN** two hermetic trains start with the same injected timestamp
- **AND** they share one run directory or one `events.jsonl` sequence
- **THEN** the test SHALL fail

#### Scenario: Missing already-contained proven event fails the suite

- **WHEN** a hermetic `--merge` fixture reconciles an already-contained item
- **AND** the train stream has no `train_merge_proven` whose `proof_disposition` is `already-contained`
- **THEN** the test SHALL fail
