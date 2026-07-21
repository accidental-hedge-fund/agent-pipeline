## ADDED Requirements

### Requirement: An experiment cell SHALL be able to bind an API treatment to a model-endpoint executor with per-cell overrides

The eval runner SHALL be able to execute a treatment through a named `model-endpoint`
executor, supplying that cell's `model`, allowlisted `params`, and requested effort as
per-invocation overrides rather than by editing committed repository configuration. The
resolved overrides SHALL be derived deterministically from the cell's treatment coordinates,
so replaying the plan from the same manifest and seed produces the same request controls. A
treatment whose overrides are invalid for the bound executor — an unknown param key, or an
effort the executor's dialect cannot express without an explicit opt-in — SHALL fail before
the request is sent, and that failure SHALL be classified as a configuration/infrastructure
failure rather than as a treatment outcome.

#### Scenario: Per-cell model override reaches the request

- **WHEN** a cell binds an API treatment to a `model-endpoint` executor with a model
  coordinate
- **THEN** the request issued for that cell SHALL carry that model
- **AND** the repository's committed configuration SHALL be unmodified

#### Scenario: Overrides are deterministic across replays

- **WHEN** the same plan is replayed from the same manifest and seed
- **THEN** each cell SHALL resolve to the same model, params, and requested effort as before

#### Scenario: Invalid override is not a treatment outcome

- **WHEN** a cell's overrides are invalid for the bound executor
- **THEN** the cell SHALL fail before any request is issued
- **AND** the failure SHALL be recorded as an infrastructure or configuration failure, not as
  a completed treatment outcome

---

### Requirement: Experiment cell records SHALL distinguish API endpoint treatments from CLI harness treatments

Every experiment cell record SHALL carry the execution/authentication class of the treatment
it executed, marking a `model-endpoint` treatment as an API-key endpoint execution and a
local CLI harness treatment as a subscription/OAuth CLI execution. Cell records for API
treatments SHALL additionally carry the endpoint provenance captured for the invocation —
requested and resolved model, upstream provider, request id, usage, and cost — with unknown
values represented as such. A report or aggregation SHALL be able to separate the two classes
from the recorded field alone.

#### Scenario: API cell record marked and carries provenance

- **WHEN** a cell executes an API treatment through a `model-endpoint` executor
- **THEN** its record SHALL carry the API-key endpoint execution class
- **AND** SHALL carry the captured endpoint provenance for that invocation

#### Scenario: CLI cell record keeps its own class

- **WHEN** a cell executes a treatment through a local CLI harness
- **THEN** its record SHALL carry the CLI execution class and SHALL NOT be marked as an
  API-key endpoint execution

#### Scenario: Classes are separable from the record alone

- **WHEN** an aggregation groups cells by execution class
- **THEN** it SHALL be able to do so from the recorded class field without inspecting the
  treatment's model or provider values
