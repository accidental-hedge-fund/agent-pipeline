## ADDED Requirements

### Requirement: Recovered loop item block SHALL NOT STOP a later ready-to-deploy train item

The pipeline SHALL classify a train advance-wave item as ok with terminal `ready-to-deploy` when live GitHub labels include `pipeline:ready-to-deploy` and do not include `blocked`, and that item’s last terminal for the wave is a successful ready terminal (`ready_to_deploy` or wave `all_done` / `loop_run_complete` with no later `loop_run_stopped` for the run). An earlier `loop_item_blocked` for the same item, including class `implementation-ci` or any other recovered class, SHALL NOT by itself make the outcome non-ok and SHALL NOT become the train STOP / per-item `error` reason.

The last **terminal** event for that item SHALL win. A later successful terminal SHALL supersede earlier item-block evidence for that item. A later `loop_run_stopped` for the attempt, a non-zero engine failure, or an engine failure message SHALL still make the outcome non-ok even when live labels include `pipeline:ready-to-deploy` (existing #1074 law). A live `blocked` label SHALL remain a park, not a merge candidate.

When `--merge` is provided and that item classifies ok at `ready-to-deploy`, the train SHALL invoke the existing issue-PR merge surface for its linked open PR instead of STOPping with a recovered block class. Production train SHALL continue to use multi-item loop advance waves and SHALL NOT merge inside advance/loop.

#### Scenario: Recovered implementation-ci then ready-to-deploy classifies ok

- **WHEN** a train advance wave’s events include `loop_item_blocked` with class `implementation-ci` for issue N
- **AND** a later event for that same item is `ready_to_deploy` or the wave ends `all_done` / `loop_run_complete` with no later `loop_run_stopped`
- **AND** live labels for issue N include `pipeline:ready-to-deploy` and do not include `blocked`
- **THEN** train advance classification for issue N SHALL be ok with terminal `ready-to-deploy`
- **AND** the outcome SHALL NOT be non-ok solely because of the earlier `loop_item_blocked`

#### Scenario: Historical loop_item_blocked does not remain current after a later successful terminal

- **WHEN** the shared train advance evidence extractor scans a run whose events list `loop_item_blocked` for issue N and then a later successful terminal for issue N (`ready_to_deploy` or wave `all_done` / `loop_run_complete` with no later `loop_run_stopped`)
- **THEN** the extracted current evidence for issue N SHALL NOT report that blocked class as the current terminal
- **AND** a later consumer of that evidence SHALL NOT treat the recovered block as the wave’s current failure for issue N

#### Scenario: #1074 live R2D plus current loop_run_stopped remains non-ok

- **WHEN** live labels for issue N include `pipeline:ready-to-deploy`
- **AND** the attempt’s current evidence includes `loop_run_stopped` (or a non-zero engine failure / engine failure message)
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** the human-visible error SHALL quote the stop reason or engine failure per existing structured-evidence law
- **AND** it SHALL NOT treat the attempt as successful solely because an earlier label said ready-to-deploy

#### Scenario: Live blocked label is not a recovered success

- **WHEN** live labels for issue N include `blocked`
- **AND** events include `loop_item_blocked` for issue N
- **THEN** train SHALL NOT classify that item as a ready-to-deploy success
- **AND** merge-mode SHALL NOT merge that item on the recovered-block path

#### Scenario: Merge-mode train merges the recovered R2D item

- **WHEN** `pipeline train --merge` finishes an advance wave that matches the recovered-block-then-ready-to-deploy scenario for issue N
- **AND** issue N has a linked open PR that passes the existing merge gates
- **THEN** the train SHALL invoke the existing merge surface for that PR
- **AND** it SHALL NOT STOP with a reason whose sole current class is the recovered `loop_item_blocked` class (for example `implementation-ci on #N`)

#### Scenario: Current loop_item_blocked plus R2D label flicker remains non-ok

- **WHEN** a train advance wave’s current evidence for issue N still has `loop_item_blocked` as that item’s last terminal (no later `ready_to_deploy` / `all_done` / `loop_run_complete`)
- **AND** live labels for issue N include `pipeline:ready-to-deploy` and do not include `blocked`
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** it SHALL NOT treat the attempt as successful solely because a ready-to-deploy label is present

#### Scenario: Reasonless loop_run_stopped remains non-ok on live R2D

- **WHEN** live labels for issue N include `pipeline:ready-to-deploy`
- **AND** the attempt’s events include `loop_run_stopped` with a missing or empty reason
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** the extracted evidence SHALL record a current stop marker independently of the optional reason
- **AND** the human-visible error SHALL quote a stable fallback diagnostic when no reason is available

#### Scenario: Multi-item recovered blocks then all_done do not remain current

- **WHEN** the shared extractor scans `loop_item_blocked` for two or more items
- **AND** a later wave terminal is `all_done` / `loop_run_complete` with no later `loop_run_stopped`
- **THEN** the extracted current evidence SHALL NOT report any of those blocked classes as the current terminal

#### Scenario: Recovered-block classification is regression-tested with injected deps

- **WHEN** the automated train tests for this requirement run under `npm run ci`
- **THEN** at least one fixture SHALL fail if `loop_item_blocked` then later `ready_to_deploy` / `all_done` plus live `pipeline:ready-to-deploy` is classified non-ok
- **AND** at least one fixture SHALL fail if live `pipeline:ready-to-deploy` plus current `loop_run_stopped` or non-zero engine failure is classified ok
- **AND** at least one merge-mode fixture SHALL fail if that recovered R2D item is STOPped instead of offered to the merge surface
- **AND** the tests SHALL inject deps (no real network, git, or subprocess for this logic)
