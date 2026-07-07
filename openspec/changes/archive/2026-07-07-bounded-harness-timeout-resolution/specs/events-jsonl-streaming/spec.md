## ADDED Requirements

### Requirement: harness_timeout is recorded in events.jsonl when a harness wall-clock cap fires

The harness invocation path SHALL append a `harness_timeout` event to `events.jsonl` at the moment a `runCapped` wall-clock cap fires — before, and independent of, the `runCapped` promise resolving — so an external supervisor tailing the event stream can detect a wedged harness without process introspection. The event SHALL contain at minimum `schema_version` (integer), `type: "harness_timeout"`, `at` (ISO 8601 UTC string), a stage/label identifier for the timed-out invocation, and `timeout_sec` (the configured cap). Recording SHALL be best-effort: when the invocation carries no run-store context (a bare `runCapped` caller), no event is appended and behavior is unchanged, and an append failure SHALL NOT change the harness outcome. The event type is additive and SHALL NOT change `schema_version`, which remains `1`; `readEvents()` SHALL NOT reject or skip `harness_timeout` events.

#### Scenario: harness_timeout appended at cap-fire time

- **WHEN** a `runCapped` invocation that carries a run-store context exceeds its wall-clock cap
- **THEN** a `harness_timeout` event SHALL be appended to `events.jsonl` at the moment the cap fires
- **AND** the event SHALL contain `schema_version`, `type: "harness_timeout"`, `at`, the stage/label of the invocation, and `timeout_sec`
- **AND** it SHALL be appended before — and independent of — the `runCapped` promise resolving

#### Scenario: no harness_timeout on a normal pre-cap exit

- **WHEN** a harness invocation exits normally before its wall-clock cap fires
- **THEN** no `harness_timeout` event SHALL be appended to `events.jsonl`

#### Scenario: bare runCapped caller with no run-store context records nothing

- **WHEN** a `runCapped` caller passes no run-store context and its cap fires
- **THEN** no `harness_timeout` event SHALL be appended
- **AND** the caller's behavior SHALL be identical to before this change

#### Scenario: reader includes harness_timeout and stage-timeline filters exclude it

- **WHEN** `readEvents()` is called on an `events.jsonl` containing `harness_timeout` events mixed with `stage_start`/`stage_complete` events
- **THEN** the `harness_timeout` events SHALL be present in the returned array
- **AND** a consumer filtering for `stage_start`/`stage_complete` to reconstruct the stage timeline SHALL exclude `harness_timeout` events

#### Scenario: harness_timeout streams in json-events mode

- **WHEN** the pipeline runs with `--json-events` and a `harness_timeout` event is appended to `events.jsonl`
- **THEN** the same JSON line SHALL also be written to stdout
