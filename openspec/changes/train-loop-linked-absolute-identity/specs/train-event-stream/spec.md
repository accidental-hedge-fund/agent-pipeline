## MODIFIED Requirements

### Requirement: Train SHALL publish train_loop_linked from the child onRunReady handoff

Train SHALL append `train_loop_linked` from the child loop's typed `onRunReady` handoff after the loop store and the exact events path exist, and before that child can block on work. Production `advanceWaveThroughLoop` SHALL await `onLoopReady` from inside the existing `onRunReady` handler so `train_loop_linked` is durably appended before `runLoopEngine` returns and before the child can block. A fire-and-forget callback SHALL NOT satisfy this requirement. The sole append site for `train_loop_linked` SHALL be that awaited `onLoopReady` callback keyed to the child-loop handoff identity (`loop_run_id` plus absolute events path). Train SHALL append `train_loop_linked` only when that handoff has a nonempty run id and a nonempty absolute events path. Train SHALL omit `train_loop_linked` when the events path is missing, empty, or not absolute. Train SHALL NOT invent an events path. Production `advanceWaveThroughLoop` SHALL invoke `onLoopReady` only when that same pair is confirmed. Wave-result `loopRun` SHALL confirm the same identity or, on mismatch, keep the first live link and set `events_coverage` to `degraded`. A later `onLoopReady` handoff that repeats the same identity SHALL NOT append. A later `onLoopReady` or wave-result handoff that disagrees on path or run id for an already published live link SHALL keep the first link, SHALL NOT append, and SHALL set `events_coverage` to `degraded`. An omitted incomplete handoff SHALL NOT by itself set `events_coverage` to `degraded`. Wave-result `loopRun` SHALL NOT append `train_loop_linked` and SHALL NOT replace the live identity with a guessed run, a latest-run lookup, or a synthetic `pipeline-loop-…` string. The event SHALL include the train `run_id`, the wave identity, the exact child loop `run_id`, and the absolute loop `events.jsonl` path from that handoff. Train SHALL emit each live linkage once. Train SHALL NOT scrape stdout or stderr prose to mint the link. These omit, duplicate, and conflict outcomes SHALL NOT change advance, merge, retry, or exit status.

#### Scenario: Live child is followable before it is terminal

- **WHEN** a train advance wave starts a child loop that remains blocked or otherwise live
- **AND** that child has fired `onRunReady` with run id `abc` and absolute events path `E`
- **THEN** the train `events.jsonl` SHALL contain `train_loop_linked` with `loop_run_id` equal to `abc` and `events` equal to `E`
- **AND** that line SHALL exist before the child loop reaches a terminal state
- **AND** that line SHALL exist before `advanceWave` returns
- **AND** `onLoopReady` SHALL have been awaited inside `onRunReady` before `runLoopEngine` returns its drive result

#### Scenario: Duplicate handoff does not append a second link

- **WHEN** train has already appended `train_loop_linked` for loop run `abc` and absolute events path `E` from `onRunReady`
- **AND** a later `onLoopReady` or wave result reports the same loop run `abc` and path `E`
- **THEN** the train stream SHALL contain exactly one `train_loop_linked` for `abc` and `E`
- **AND** that event SHALL keep the original `loop_run_id` and events path
- **AND** `events_coverage` SHALL remain `ok` or omitted

#### Scenario: Wave result MUST NOT guess a different run

- **WHEN** train has already linked loop run `abc` from `onRunReady`
- **AND** a later result would present a different or synthetic loop id
- **THEN** train SHALL keep `abc`
- **AND** SHALL NOT append a replacement `train_loop_linked`

#### Scenario: Conflicting later handoff degrades evidence and keeps the first link

- **WHEN** train has already linked loop run `abc` and events path `E` from `onRunReady`
- **AND** a later wave result reports a different loop run `xyz` and path `F`
- **THEN** the train stream SHALL keep the first `train_loop_linked` for `abc` and `E`
- **AND** SHALL NOT append a second `train_loop_linked`
- **AND** `train_status.events_coverage` SHALL equal `degraded`
- **AND** the wave result, merge decisions, retry behavior, and exit status SHALL be unchanged

#### Scenario: Same run id with a different absolute path degrades and keeps the first link

- **WHEN** train has already linked loop run `abc` and events path `E` from `onRunReady`
- **AND** a later `onLoopReady` reports loop run `abc` and a different absolute path `F`
- **THEN** the train stream SHALL keep the first `train_loop_linked` for `abc` and `E`
- **AND** SHALL NOT append a second `train_loop_linked`
- **AND** `train_status.events_coverage` SHALL equal `degraded`
- **AND** the wave result, merge decisions, retry behavior, and exit status SHALL be unchanged

#### Scenario: Different run id with the same absolute path degrades and keeps the first link

- **WHEN** train has already linked loop run `abc` and events path `E` from `onRunReady`
- **AND** a later `onLoopReady` or wave result reports a different loop run `def` and the same path `E`
- **THEN** the train stream SHALL keep the first `train_loop_linked` for `abc` and `E`
- **AND** SHALL NOT append a second `train_loop_linked`
- **AND** `train_status.events_coverage` SHALL equal `degraded`
- **AND** the wave result, merge decisions, retry behavior, and exit status SHALL be unchanged

#### Scenario: Missing events path does not append train_loop_linked

- **WHEN** `onLoopReady` fires with nonempty run id `abc` and no events path
- **THEN** train SHALL NOT append `train_loop_linked`
- **AND** `events_coverage` SHALL remain `ok` or omitted
- **AND** advance, merge, retry, and exit status SHALL be unchanged

#### Scenario: Relative events path does not append train_loop_linked

- **WHEN** `onLoopReady` fires with nonempty run id `abc` and events path `runs/abc/events.jsonl`
- **THEN** train SHALL NOT append `train_loop_linked`
- **AND** `events_coverage` SHALL remain `ok` or omitted
- **AND** advance, merge, retry, and exit status SHALL be unchanged

#### Scenario: Wave result is not an append site

- **WHEN** `onRunReady` never fired for a wave
- **AND** the later wave result reports a loop run id
- **THEN** train SHALL NOT append `train_loop_linked` from that wave result
- **AND** train SHALL omit `train_loop_linked` when no live loop store was confirmed on `onRunReady`

### Requirement: Unit tests SHALL cover train events through injected seams

The implementation SHALL provide unit tests that inject train, run-store, clock/ID, mkdir, and wave seams (no real network, git, or subprocess) and that fail if: no train-level `events.jsonl` is written before the first wave when allocation succeeds; the published run ID is not the generic-store basename; a confirmed live `onRunReady` loop run ID is omitted from `train_loop_linked` until the child is terminal; a duplicate handoff appends a second link; a later mismatched wave result replaces the live link or aborts the wave; a handoff with a run id and no events path still appends `train_loop_linked`; a handoff with a relative events path still appends `train_loop_linked`; a later handoff with the same run id and a different absolute path replaces the first link, appends a second link, or leaves `events_coverage` healthy; a later handoff with a different run id and the same already-published absolute path appends a second link or leaves `events_coverage` healthy; two same-clock trains share one run directory or one `seq` stream; an `EEXIST` collision writes the colliding directory; a non-`EEXIST` mkdir failure suffix-retries or opens a store; exhausted allocation writes a shared store or changes which issues advance or merge; store-file init after exclusive claim appends into a pre-existing sibling directory; `run_complete` is missing on a normal STOP/complete exit; `train --json` stdout contains `train_run_handoff` or extra JSON objects; `run.json` looks like a single-issue advance run; a newly merged contained item omits `train_merge_proven` with `proof_disposition` `newly-merged`; or an already-contained item omits `train_merge_proven` with `proof_disposition` `already-contained`. Newly-merged and already-contained proof-event tests SHALL assert identical payload and ordering invariants except `proof_disposition`. At least one regression SHALL fail against today's stdout-only train without the store. At least one regression SHALL fail against today's live-link append that publishes when `eventsPath` is missing or not absolute, against today's run-id-only duplicate suppression that drops a same-run-id different-path handoff without degrading coverage, and against today's path-unindexed live-link lookup that appends a second `train_loop_linked` when a later wave reuses a published events path with a different run id.

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

#### Scenario: Non-EEXIST mkdir retry fails the suite

- **WHEN** a hermetic mkdir seam fails exclusive create with `EACCES`
- **AND** the fixture suffix-retries or opens a store
- **THEN** the test SHALL fail

#### Scenario: Init after failed claim fails the suite

- **WHEN** a hermetic exclusive mkdir fails
- **AND** the fixture still calls `initRunDir` on that pre-existing path
- **THEN** the test SHALL fail

#### Scenario: Missing events path still appending fails the suite

- **WHEN** a hermetic fixture calls `onLoopReady` with a nonempty run id and no events path
- **AND** the train stream contains `train_loop_linked`
- **THEN** the test SHALL fail

#### Scenario: Relative events path still appending fails the suite

- **WHEN** a hermetic fixture calls `onLoopReady` with a nonempty run id and a relative events path
- **AND** the train stream contains `train_loop_linked`
- **THEN** the test SHALL fail

#### Scenario: Same-id different-path silent drop fails the suite

- **WHEN** a hermetic fixture publishes `train_loop_linked` for loop run `abc` and absolute path `E`
- **AND** a later `onLoopReady` reports `abc` and a different absolute path `F`
- **AND** the first link is replaced, a second link is appended, or `events_coverage` is not `degraded`
- **THEN** the test SHALL fail

#### Scenario: Same-path different-id silent reuse fails the suite

- **WHEN** a hermetic fixture publishes `train_loop_linked` for loop run `abc` and absolute path `E`
- **AND** a later wave `onLoopReady` reports `def` and the same absolute path `E`
- **AND** a second link is appended, the first identity is replaced, or `events_coverage` is not `degraded`
- **THEN** the test SHALL fail

### Requirement: Train events_coverage SHALL follow a closed observational transition set

Train SHALL publish additive `train_status.events_coverage` as one of `ok`, `degraded`, or `unknown` when coverage is known. Successful exclusive identity allocation and event-store init SHALL set `events_coverage` to `ok` or omit the field. Exhausted exclusive create where every attempt failed with `EEXIST` SHALL set `events_coverage` to `degraded` and SHALL omit `run_id`. A non-`EEXIST` exclusive-create error before any claim succeeds SHALL set `events_coverage` to `unknown` and SHALL omit `run_id`. Store-file initialization failure after an exclusive claim SHALL set `events_coverage` to `degraded` and SHALL NOT append into a directory this invocation did not exclusively create. A failed `train_loop_linked` append after a published store SHALL set `events_coverage` to `degraded` and SHALL keep `run_id`. A later handoff (`onLoopReady` or wave-result `loopRun`) that disagrees with the live link on run id or events path SHALL set `events_coverage` to `degraded` and SHALL keep the first live link. An omitted incomplete handoff (missing, empty, or non-absolute events path) SHALL NOT by itself set `events_coverage` to `degraded`. Coverage transitions SHALL NOT change train mutations, merge decisions, retry behavior, exit status, or `train --json` stdout object kind. The only permitted stdout change is the additive `events_coverage` field and the optional omission of `run_id`.

#### Scenario: Successful claim is ok or omitted

- **WHEN** exclusive identity allocation succeeds and event-store init succeeds
- **THEN** `train_status` SHALL include `run_id` equal to the claimed train id
- **AND** `events_coverage` SHALL equal `ok` or SHALL be omitted
- **AND** `schema_version` SHALL remain `1`

#### Scenario: EEXIST exhaustion is degraded and omits run_id

- **WHEN** every exclusive create attempt fails with `EEXIST`
- **THEN** `events_coverage` SHALL equal `degraded`
- **AND** `train_status` SHALL omit `run_id`

#### Scenario: Non-EEXIST mkdir failure is unknown and omits run_id

- **WHEN** exclusive create fails with `EACCES` before any claim succeeds
- **THEN** `events_coverage` SHALL equal `unknown`
- **AND** `train_status` SHALL omit `run_id`

#### Scenario: Store init failure after exclusive claim is degraded

- **WHEN** exclusive create succeeds
- **AND** store-file initialization then fails
- **THEN** `events_coverage` SHALL equal `degraded`
- **AND** train SHALL NOT append into a sibling pre-existing `train-*` directory

#### Scenario: Coverage does not change stdout object kind

- **WHEN** `events_coverage` is `ok`, `degraded`, or `unknown`
- **THEN** `train --json` stdout SHALL still parse as exactly one `train_status` object
- **AND** exit status, merge decisions, and which issues advance SHALL be unchanged

#### Scenario: Incomplete live handoff does not degrade coverage

- **WHEN** exclusive identity allocation succeeds
- **AND** `onLoopReady` fires with a nonempty run id and a missing or relative events path
- **THEN** train SHALL NOT append `train_loop_linked`
- **AND** `events_coverage` SHALL equal `ok` or SHALL be omitted
