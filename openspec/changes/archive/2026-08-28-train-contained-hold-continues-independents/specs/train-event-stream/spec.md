## MODIFIED Requirements

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
