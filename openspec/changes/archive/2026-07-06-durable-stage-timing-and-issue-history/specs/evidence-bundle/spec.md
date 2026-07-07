## MODIFIED Requirements

### Requirement: PR or issue receives a single path-notification comment at finalization

After `finalizeBundle()` succeeds, the pipeline SHALL post a comment on the PR (or issue if
no PR is open) that is self-contained on GitHub. The comment body SHALL include: (a) the run
id as a visibly labeled field (not only embedded inside a file path); (b) a per-stage timing
table rendered in Markdown with one row per recorded stage, each row showing the stage name,
its `enteredAt`→`exitedAt` timestamps, the stage duration, the stage's harness invocation
duration, and the stage outcome; and (c) the local file path of the run-directory bundle
(and/or the `pipeline N --summary` hint) as secondary/optional context. The timing table, run
id, and outcome SHALL be complete and correct using only data carried in the comment body —
no field in the table SHALL depend on local filesystem access to render. The comment SHALL be
posted at most once per run: if the bundle already records a notification, the comment SHALL
be skipped on subsequent finalization calls. The comment body SHALL be derived solely from
the finalized bundle's stage/timing/outcome and identity fields, plus the wall-clock
`duration_ms` of harness invocations recorded for each stage, and SHALL NOT include
accounting payloads (token counts, cost values, prompts, responses, transcripts, or provider
payloads).

#### Scenario: comment posted at finalization with run id and timing table

- **WHEN** `finalizeBundle()` is called and no prior notification is recorded in the bundle
- **THEN** the orchestrator SHALL post a comment whose body contains the run id as a labeled
  field
- **AND** the body SHALL contain a Markdown table with one row per recorded stage showing
  stage name, `enteredAt`→`exitedAt`, duration, harness invocation duration, and outcome
- **AND** the body SHALL still reference the local run-directory bundle path (or the
  `pipeline N --summary` hint) as secondary context
- **AND** the bundle SHALL record a `notifiedAt` timestamp after posting

#### Scenario: timing table renders without local filesystem access

- **WHEN** the finalization comment is rendered for a run whose local run directory is later
  unavailable (e.g. viewed from a different machine)
- **THEN** the run id, per-stage timing table, and outcome in the comment body SHALL remain
  complete and correct
- **AND** no field in the table SHALL require reading `.agent-pipeline/runs/` or the legacy
  evidence path to display

#### Scenario: comment omits accounting data

- **WHEN** finalization posts the comment for a run that recorded accounting data
- **THEN** the comment body SHALL NOT contain token counts, cost values, prompts, responses,
  transcripts, provider payloads, or secret values
- **AND** the comment body SHALL contain only wall-clock stage and harness-invocation
  durations, the run id, and the local path reference

#### Scenario: comment not re-posted

- **WHEN** `finalizeBundle()` is called and `notifiedAt` is already set in the bundle
- **THEN** the orchestrator SHALL NOT post another comment
