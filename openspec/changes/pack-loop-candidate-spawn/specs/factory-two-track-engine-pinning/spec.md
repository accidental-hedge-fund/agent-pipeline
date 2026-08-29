## ADDED Requirements

### Requirement: Ship-end pack-loop spawn SHALL exec the resolved candidate launcher

When pin SHA `P` and candidate SHA `C` differ, the nested factory-gate pack loop that interprets a contract written by candidate `factory-release prepare` SHALL exec the same verified candidate launcher that ran that prepare. The invocation SHALL carry an absolute executable, argv, and candidate SHA `C`. PATH `pipeline` and `PIPELINE_BIN` SHALL NOT be production fallbacks for that child, even when `PIPELINE_BIN` is unset. `--engine-track candidate` on the child argv SHALL remain intent and diagnostic metadata. It SHALL NOT select the binary. Ordinary pinned-track production and dogfood loops SHALL still exec the production pin.

#### Scenario: Pin drives a candidate contract

- **WHEN** candidate SHA `C` has recovery recipe `publish_unpublished_stage_commit`
- **AND** PATH `pipeline` is an older pin `P` whose catalogue rejects that recipe
- **AND** candidate prepare dispatches the pack loop without `PIPELINE_BIN`
- **THEN** the child SHALL be the candidate engine for `C`
- **AND** it SHALL NOT throw the catalogue validation error that pin `P` would throw

#### Scenario: Engine-track flag is not a binary selector

- **WHEN** pack-loop spawn argv includes `--engine-track candidate`
- **AND** pin SHA `P` is on PATH as `pipeline`
- **THEN** the spawned executable SHALL still be the resolved candidate launcher for `C`
- **AND** documentation SHALL NOT treat `--engine-track candidate` as the binary selector

#### Scenario: PIPELINE_BIN is not a production fallback

- **WHEN** `PIPELINE_BIN` is unset
- **AND** pin SHA `P` ≠ candidate SHA `C`
- **THEN** pack-loop spawn SHALL NOT exec PATH `pipeline`
- **AND** it SHALL exec the absolute candidate launcher resolved for `C`

#### Scenario: Pinned dogfood stays on the pin

- **WHEN** a factory production or dogfood loop is intended as pinned-track
- **THEN** it SHALL still execute the production pin
- **AND** the pack-loop candidate-spawn rule SHALL NOT cause that loop to run the unpromoted candidate as if it were production
