## ADDED Requirements

### Requirement: Tugboat SHALL launch bundled stage-watch with argv that script accepts

Tugboat SHALL invoke the default `SHIP_STAGE_WATCH_BIN` (the repo sibling `examples/supervisor/shell/ship-stage-watch.sh`, or an installed copy of that same contract) with an argv that script accepts when it starts optional per-issue stage posts during train. The product watch contract is `--events-file` only. Tugboat SHALL pass `--events-file` set to an absolute `events.jsonl` path taken from the live train/loop handoff (`kind: loop_run_handoff` field `events`, or equivalent). Tugboat SHALL NOT pass `--milestone` or `--since` while the bundled usage / argv parser documents `--events-file` and rejects `--milestone`. Tugboat SHALL NOT glob host-global run directories or select the newest `events.jsonl` by mtime. Tugboat SHALL start that watch in time to observe train stage events. Tugboat SHALL NOT wait until train has completed before attaching watch to a known live events path. Default `SHIP_STAGE_WATCH_BIN` SHALL remain that sibling contract. Installing an older `--milestone` binary on PATH SHALL NOT be required for Buzz stage posts.

#### Scenario: Train watch passes --events-file from the live handoff

- **WHEN** Tugboat enters the train phase for milestone `vX.Y.Z`
- **AND** `SHIP_STAGE_WATCH_BIN` is executable
- **AND** train emits a live `loop_run_handoff` whose `events` field is an absolute `events.jsonl` path
- **THEN** Tugboat SHALL invoke that binary with `--events-file` set to that absolute path
- **AND** it SHALL NOT pass `--milestone`
- **AND** it SHALL NOT pass `--since`

#### Scenario: Tugboat does not discover a latest run

- **WHEN** Tugboat starts stage-watch for a train
- **THEN** the `--events-file` argument SHALL be the live handoff absolute path
- **AND** Tugboat SHALL NOT search `~/.local/state/agent-pipeline` (or equivalent) for the newest `events.jsonl`

#### Scenario: Default watch binary is the repo sibling

- **WHEN** the operator has not set `SHIP_STAGE_WATCH_BIN`
- **THEN** Tugboat SHALL default it to the sibling `ship-stage-watch.sh` next to Tugboat
- **AND** Buzz stage posts SHALL NOT require `~/.local/bin/ship-stage-watch` on PATH

#### Scenario: Watch starts while train is still running

- **WHEN** Tugboat has the live handoff absolute `events` path during train
- **THEN** it SHALL spawn stage-watch with `--events-file` set to that path before train completes
- **AND** it SHALL NOT defer that spawn until after the train JSON capture is finished

### Requirement: Tugboat SHALL NOT claim a live stage-watch pid after argv reject

Tugboat SHALL log a named failure (`stage-watch argv rejected` or equivalent) when the bundled stage-watch exits non-zero on argv parse (including exit 2 for `unknown argument: --milestone`) or the spawn otherwise fails immediately. Tugboat SHALL NOT log `stage-watch started pid=…` for that spawn. Tugboat SHALL NOT treat a pid-file left by a dead watch process as proof the watch is live. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: --milestone reject is a named failure not a started pid

- **WHEN** Tugboat would spawn stage-watch with `--milestone`
- **AND** the bundled script exits 2 with `unknown argument: --milestone`
- **THEN** Tugboat SHALL log `stage-watch argv rejected` (or equivalent)
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn
- **AND** it SHALL NOT claim a live watch pid
- **AND** it SHALL still run `pipeline train`

#### Scenario: Successful watch may log started only after argv parse succeeds

- **WHEN** Tugboat spawns the bundled watch with accepted argv
- **AND** that process remains live after argv parse
- **THEN** Tugboat MAY log a started pid
- **AND** that pid SHALL match a process that did not exit non-zero on argv parse

### Requirement: Tugboat stage-watch argv SHALL be regression-tested against the bundled script

Automated checks SHALL extract the Tugboat train-phase stage-watch launch from `examples/supervisor/shell/tugboat.sh` and the bundled `examples/supervisor/shell/ship-stage-watch.sh` `usage` / argv parser. Those checks SHALL fail if Tugboat passes `--milestone` to the watch while the bundled usage / parser only documents `--events-file`. Tests SHALL inspect those sources (and MAY extract helpers). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on the v1.39.8 --milestone watch spawn

- **WHEN** the automated checks run against a Tugboat train watch launch that passes `--milestone`
- **AND** the bundled `ship-stage-watch.sh` usage / argv parser documents `--events-file` and does not accept `--milestone`
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when Tugboat passes --events-file

- **WHEN** the automated checks run against a Tugboat train watch launch that passes `--events-file` and does not pass `--milestone`
- **AND** the bundled usage / parser documents `--events-file`
- **THEN** the checks SHALL pass
