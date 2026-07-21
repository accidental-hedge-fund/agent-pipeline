# papercut-capture Specification

## Purpose
TBD - created by archiving change papercut-capture. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL record agent-reported friction as a `papercut` run event

The engine SHALL define a `papercut` member of the run event union and SHALL write it through the
same `appendEvent` path used by every other run event, so that it is appended to the run's
`events.jsonl`, screened by the write-time injection denylist, secret-redacted, and delivered to
any configured external event sink on identical terms to `blocker_set` and `human_intervention`.
The event shape SHALL be:

```
{
  schema_version: 1,
  type: "papercut",
  at: <ISO 8601 UTC string>,
  run_id: <run id string>,
  issue: <issue number integer>,
  stage: <stage name string | null>,
  harness: <harness command string | null>,
  model: <model string | null>,
  message: <string — the agent's free-text friction note>
}
```

`schema_version` SHALL remain `1`; adding this event type SHALL NOT change the schema version of
any existing event.

#### Scenario: Recorded papercut carries full provenance

- **WHEN** a papercut is recorded during a run
- **THEN** the appended event SHALL contain the run id, the issue number, the stage it occurred
  in, the harness and model identity that logged it, an ISO-8601 UTC timestamp, and the free-text
  message
- **AND** its `type` SHALL be `"papercut"` and its `schema_version` SHALL be `1`

#### Scenario: Papercut message is redacted like every other event

- **WHEN** a papercut message contains a secret pattern recognized by the existing redaction and
  injection-denylist screening
- **THEN** the matching span SHALL be replaced before the line is written to `events.jsonl` or
  delivered to a sink
- **AND** the event SHALL still be written rather than dropped

#### Scenario: Papercut reaches a configured event sink

- **WHEN** an `event_sink.command` is configured and a papercut is recorded for that run
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`, on the
  same terms as a `blocker_set` or `human_intervention` event for that run

---

### Requirement: `pipeline papercut` SHALL record one papercut without disturbing the run

The pipeline CLI SHALL accept `papercut` as a no-issue-number positional sub-command. Invoked as
`pipeline papercut --run <run-id> -m "<message>"`, it SHALL append one `papercut` event to the
named run and exit zero. Invocation SHALL NOT block, pause, fail, or otherwise alter the run or
stage from which it was called. When the run/stage/harness/model context is supplied by the engine
through the harness child-process environment, the command SHALL use those values as defaults;
explicitly-passed values SHALL take precedence.

#### Scenario: Recording a papercut mid-run leaves the run unaffected

- **WHEN** an agent runs `pipeline papercut --run <run-id> -m "npm ci failed once, retried"` from
  inside a stage
- **THEN** a `papercut` event tagged with that run SHALL be recorded
- **AND** the command SHALL exit zero
- **AND** the invoking run and stage SHALL continue and complete exactly as they would have
  without the invocation

#### Scenario: A failed papercut write never becomes a stage failure

- **WHEN** appending the papercut event throws an I/O error
- **THEN** the command SHALL catch the error, emit a non-fatal warning, and exit zero
- **AND** the invoking run/stage SHALL continue and complete normally
- **AND** no `blocker_set` event SHALL be emitted as a result, and the stage SHALL NOT be reported
  as failed

---

### Requirement: `pipeline papercut report` SHALL return the papercuts in a time window as JSON

The CLI SHALL accept `pipeline papercut report --since <date> [--until <date>] --json` and SHALL
print a JSON array of the recorded `papercut` events whose `at` timestamp falls within the given
window. `--since`/`--until` SHALL use the ISO-8601 date convention already used by the `improve`
and `scoreboard` commands. Events outside the window SHALL be excluded. Unreadable or malformed
event lines SHALL be skipped rather than aborting the report.

#### Scenario: Report includes only in-window papercuts

- **WHEN** papercut events exist both inside and outside the requested window and
  `pipeline papercut report --since <date> --json` is run
- **THEN** the printed JSON array SHALL contain every in-window papercut event
- **AND** SHALL contain no event whose timestamp falls outside the window

#### Scenario: Empty window returns an empty array, not an error

- **WHEN** `pipeline papercut report --since <date> --json` is run over a window containing zero
  papercut events
- **THEN** the command SHALL print `[]` and exit zero

---

### Requirement: The `papercut` command SHALL be agent-facing and omitted from the human command surface

The `papercut` sub-command SHALL be registered in the command registry with its own flag
allowlist, and SHALL remain directly invocable by name. It SHALL NOT appear in the CLI `--help`
sub-command listing, and SHALL NOT be exposed as a `pipeline:papercut` entry in the generated host
command surface for either the Claude or the Codex host.

#### Scenario: Hidden from help but still executable

- **WHEN** `pipeline --help` is run
- **THEN** the output SHALL contain no `papercut` entry
- **AND** running `pipeline papercut --run <run-id> -m "<message>"` directly SHALL still execute
  and record the event

#### Scenario: No host command entry is generated

- **WHEN** the generated Claude and Codex host command surfaces are enumerated
- **THEN** neither SHALL contain a `pipeline:papercut` entry

---

### Requirement: A `papercuts` config block SHALL gate the feature and SHALL reject unknown keys

The `.github/pipeline.yml` schema SHALL accept an optional strict `papercuts` block carrying an
`enabled` toggle plus the opt-in auto-file settings `auto_file` (boolean), `auto_file_window_hours`
(positive number), `auto_file_max_per_window` (positive integer), and `auto_file_min_occurrences`
(integer ≥ 2). When the block is absent, or when `papercuts.enabled` is `false`, the capture feature
SHALL be inert. When `auto_file` is absent it SHALL resolve to `false`, and every auto-file code path
SHALL be inert. An unrecognized key inside the `papercuts` block SHALL cause `resolveConfig()` to
fail with a schema error naming the offending field, consistent with how `event_sink` and other
optional strict blocks are validated.

#### Scenario: Valid block enables the feature

- **WHEN** `.github/pipeline.yml` contains `papercuts: { enabled: true }`
- **THEN** `resolveConfig()` SHALL validate successfully and resolve the feature as enabled

#### Scenario: Unknown key inside the block is rejected

- **WHEN** `.github/pipeline.yml` contains a `papercuts` block with an unrecognized key
- **THEN** `resolveConfig()` SHALL throw a schema error identifying the offending field rather
  than ignoring it

#### Scenario: Absent block leaves the feature inert

- **WHEN** `.github/pipeline.yml` contains no `papercuts` block
- **THEN** the resolved config SHALL report the feature as disabled
- **AND** SHALL report `auto_file` as `false`

#### Scenario: Auto-file keys validate and default conservatively

- **WHEN** `.github/pipeline.yml` contains `papercuts` with `enabled: true` and no `auto_file` key
- **THEN** `resolveConfig()` SHALL validate successfully
- **AND** the resolved config SHALL report `auto_file` as `false`
- **AND** SHALL expose defaulted values for `auto_file_window_hours`,
  `auto_file_max_per_window`, and `auto_file_min_occurrences`

#### Scenario: Out-of-range auto-file values are rejected

- **WHEN** `.github/pipeline.yml` sets `auto_file_max_per_window` to zero or a negative number, or
  sets `auto_file_min_occurrences` below 2
- **THEN** `resolveConfig()` SHALL throw a schema error naming the offending field rather than
  silently clamping the value

### Requirement: The papercut prompt instruction SHALL be single-sourced and config-gated

When `papercuts.enabled` is true, the engine SHALL inject one single-sourced papercut instruction
into the implementing, fix, and review prompt templates, and the injected text SHALL be the
identical string in all three. When the feature is disabled, those templates SHALL contain no
papercut instruction text and their rendered output SHALL be byte-for-byte identical to the
pre-change output. The instruction text SHALL explicitly distinguish a papercut (minor friction —
log it and continue) from a review finding (a defect to report through the review verdict) and
from a blocker (work stopped and human input required), and SHALL state the exact CLI invocation
used to record one.

#### Scenario: Disabled leaves prompts byte-identical

- **WHEN** the rendered implementing, fix, and review prompts are produced with no `papercuts`
  block configured, or with `papercuts.enabled: false`
- **THEN** none of them SHALL contain papercut instruction text
- **AND** each rendered prompt SHALL be byte-for-byte identical to its pre-change output

#### Scenario: Enabled injects one identical instruction into all three prompts

- **WHEN** the rendered implementing, fix, and review prompts are produced with
  `papercuts.enabled: true`
- **THEN** each SHALL contain the papercut instruction
- **AND** the injected text SHALL be the same single-sourced string in all three

#### Scenario: Instruction draws the three-way distinction

- **WHEN** the instruction text is read from a rendered prompt
- **THEN** it SHALL state that a papercut is minor friction to log and continue past
- **AND** that a defect SHALL be reported as a review finding instead
- **AND** that work that cannot continue SHALL be raised as a blocker instead

