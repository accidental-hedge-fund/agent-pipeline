## ADDED Requirements

### Requirement: Ship-end pack-loop spawn SHALL exec the resolved candidate launcher

When pin SHA `P` and candidate SHA `C` differ, the nested factory-gate pack loop that interprets a contract written by candidate `factory-release prepare` SHALL exec the same verified candidate launcher that ran that prepare. Dispatch SHALL receive a typed candidate invocation object with an absolute executable, immutable argv, and candidate SHA `C`. The dispatcher SHALL fail closed if that object is missing or if its SHA does not equal the request candidate SHA. PATH `pipeline`, `PIPELINE_BIN`, `process.argv`, and `--engine-track` SHALL NOT be used to re-derive the executable, even when `PIPELINE_BIN` is unset. `--engine-track candidate` on the child argv SHALL remain intent and diagnostic metadata. It SHALL NOT select the binary. Ordinary pinned-track production and dogfood loops SHALL still exec the production pin.

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

#### Scenario: Missing invocation fails closed

- **WHEN** pack-loop dispatch does not receive a typed candidate invocation
- **OR** the invocation SHA does not equal the request candidate SHA
- **THEN** that tick SHALL fail closed
- **AND** it SHALL NOT exec PATH `pipeline`
