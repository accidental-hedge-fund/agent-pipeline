# machine-readable-status Specification

## Purpose
TBD - created by archiving change desktop-json-status-preflight. Update Purpose after archive.

## Requirements

### Requirement: `pipeline <issue> --status --json` SHALL emit a single unfenced JSON object

When the `--json` flag is passed alongside `--status`, the pipeline CLI SHALL write exactly one JSON object to stdout. The output SHALL NOT be wrapped in a markdown code fence, preceded by prose, or followed by trailing non-JSON bytes. The envelope SHALL be valid JSON even when the issue cannot be found or the GitHub request fails — errors SHALL be represented as `"status": "error"` with an `"error"` string field inside the envelope.

#### Scenario: JSON flag produces unfenced JSON

- **WHEN** `pipeline <issue> --status --json` is invoked for a valid issue
- **THEN** stdout SHALL contain exactly one JSON object with no surrounding prose or code fences
- **AND** `JSON.parse(stdout)` SHALL succeed

#### Scenario: Error during status fetch encoded in envelope

- **WHEN** `pipeline <issue> --status --json` is invoked and the GitHub request fails
- **THEN** stdout SHALL still be a valid JSON object
- **AND** the object SHALL contain `"status": "error"` and an `"error"` field describing the failure
- **AND** the command SHALL exit with a non-zero exit code

#### Scenario: `--status` without `--json` is unchanged

- **WHEN** `pipeline <issue> --status` is invoked without `--json`
- **THEN** stdout SHALL be identical to the pre-change prose output
- **AND** no JSON is emitted

### Requirement: The JSON status envelope SHALL include a required set of fields

The JSON object produced by `--status --json` SHALL include the following fields at minimum:

- `schema_version` (string): envelope version identifier, e.g. `"1"`.
- `status` (string): top-level discriminant. Values: `"ok"`, `"blocked"`, `"needs-human"`, `"waiting"`, `"error"`.
- `issue` (object): `{ number: number, title: string }`.
- `stage` (string): the current pipeline stage label value (e.g. `"review-1"`), or `null` if no pipeline label is present.
- `pr` (object | null): `{ number: number, url: string }` when a PR exists, otherwise `null`.
- `branch` (string | null): the feature branch name when known, otherwise `null`.
- `worktree` (string | null): absolute path to the active worktree when known, otherwise `null`.
- `last_event` (object | null): `{ timestamp: string (ISO 8601), description: string }` for the most recent pipeline event (label change or pipeline comment), or `null` if none.
- `review_summary` (object | null): `{ verdict: string, findings_count: number, timestamp: string (ISO 8601) }` from the latest review verdict, or `null` if no review has run.
- `next_action` (string): human-readable description of what the pipeline will do on the next invocation.
- `config` (object): `{ repo: string, domain: string }`.

Additive fields beyond this minimum SHALL be permitted and SHALL NOT constitute a breaking change.

#### Scenario: All minimum fields present on a normal issue

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue at stage `review-1` with an open PR
- **THEN** the returned JSON SHALL include every field listed in the minimum set
- **AND** `schema_version` SHALL equal `"1"`
- **AND** `pr` SHALL be a non-null object with `number` and `url`

#### Scenario: Null fields when information is unavailable

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue that has no associated PR yet
- **THEN** `pr` SHALL be `null`
- **AND** `branch` MAY be `null`
- **AND** `worktree` MAY be `null`
- **AND** all other minimum fields SHALL still be present

#### Scenario: `stage` is null when issue has no pipeline label

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue with no `pipeline:*` label
- **THEN** `stage` SHALL be `null`
- **AND** `status` SHALL be `"blocked"` or `"error"`

### Requirement: JSON status output SHALL be covered by unit tests using the injectable deps seam

The status JSON assembly logic SHALL be exercisable through the existing `deps`/`Deps` injectable seam (providing `gh` fakes). Unit tests SHALL verify the minimum field set and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Unit test verifies minimum fields with fake deps

- **WHEN** a unit test injects `gh` fakes returning a known issue and PR state
- **AND** calls the JSON status assembly function
- **THEN** the returned object SHALL contain every minimum field
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Unit test verifies null fields when PR absent

- **WHEN** a unit test injects `gh` fakes where no PR exists for the issue
- **AND** calls the JSON status assembly function
- **THEN** `pr` SHALL be `null`

### Requirement: The JSON status envelope SHALL flag a possibly-wedged non-finalized run

The JSON object produced by `pipeline <issue> --status --json` SHALL include a `possibly_wedged` field that distinguishes a legitimately long-running stage from a wedged run. `possibly_wedged` SHALL be a non-null object `{ last_event_age_ms: number, threshold_ms: number, last_event_type: string }` when both (1) the run is not finalized — its `events.jsonl` contains no `run_complete` event — and (2) the newest `events.jsonl` entry is older than the largest configured stage timeout (the maximum over the configured per-stage timeouts). Otherwise — a finalized run, or a run whose newest event is within the threshold — `possibly_wedged` SHALL be `null`. The field is additive; the envelope `schema_version` SHALL remain `"1"`, and every other minimum status field SHALL continue to be present.

#### Scenario: unfinalized run with a stale last event is flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for a run whose `events.jsonl` has no `run_complete` event
- **AND** the newest event's timestamp is older than the largest configured stage timeout
- **THEN** `possibly_wedged` SHALL be a non-null object
- **AND** it SHALL contain `last_event_age_ms`, `threshold_ms`, and `last_event_type`

#### Scenario: finalized run is never flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for a run whose `events.jsonl` contains a `run_complete` event
- **THEN** `possibly_wedged` SHALL be `null` regardless of the last event's age

#### Scenario: recent activity is not flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for an unfinalized run whose newest event is within the largest configured stage timeout
- **THEN** `possibly_wedged` SHALL be `null`

#### Scenario: possibly_wedged is additive and does not disturb the minimum field set

- **WHEN** `pipeline <issue> --status --json` is invoked
- **THEN** the envelope SHALL still contain every field in the existing minimum status set
- **AND** `schema_version` SHALL equal `"1"`

### Requirement: The possibly-wedged computation SHALL be covered by unit tests using the injectable deps seam

The `possibly_wedged` computation SHALL be exercisable through the existing `deps` seam using a fake `events.jsonl` and configured timeouts, performing no real network, git, or subprocess calls. Tests SHALL cover the flagged case (unfinalized run with a stale newest event) and the two unflagged cases (finalized run; unfinalized run with a recent newest event).

#### Scenario: unit test flags a stale unfinalized run

- **WHEN** a unit test supplies a fake unfinalized `events.jsonl` whose newest event predates the largest configured stage timeout
- **THEN** the status assembly SHALL return a non-null `possibly_wedged` with `last_event_age_ms`, `threshold_ms`, and `last_event_type`

#### Scenario: unit test does not flag a finalized or recent run

- **WHEN** a unit test supplies a fake `events.jsonl` that either contains a `run_complete` event or whose newest event is within the threshold
- **THEN** the status assembly SHALL return `possibly_wedged: null`

### Requirement: Status JSON SHALL include event-stream write-health when available

The JSON object produced by `pipeline <issue> --status --json` SHALL include an additive field
describing event-stream write-health for the issue's latest (or active) run when that run's
write-health is readable. When write-health recorded failures, the field SHALL be a non-null object
carrying enough detail for an operator or automation to see that the event stream failed mid-run
(at minimum: failure indication, worst criticality when known, and last error or last failed event
type when known). When write-health is healthy or the run has no write-health file from a pre-change
engine, the field SHALL be `null` or an explicit healthy representation without requiring a
`schema_version` bump. The envelope `schema_version` SHALL remain `"1"`, and every other minimum
status field SHALL continue to be present.

#### Scenario: Elevated write-health appears in status JSON

- **WHEN** `pipeline <issue> --status --json` is invoked
- **AND** the latest run directory has write-health recording one or more append failures
- **THEN** the JSON envelope SHALL include a non-null write-health (or equivalent) object
- **AND** that object SHALL indicate failure and worst criticality when known
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Healthy or absent write-health does not look failed

- **WHEN** `pipeline <issue> --status --json` is invoked
- **AND** the latest run has zero recorded append failures or no write-health artifact from a
  legacy run
- **THEN** the write-health field SHALL be `null` or an explicit healthy representation
- **AND** the command SHALL NOT invent a write-health failure

### Requirement: Status prose SHALL warn when event-stream write-health is elevated

The prose status output of `pipeline <issue> --status` (without `--json`) SHALL include a clear
warning that the run event stream experienced write failure and that evidence may be incomplete when
the latest run has elevated write-health (one or more recorded append failures). When write-health
is healthy or absent, status prose SHALL NOT emit that warning.

#### Scenario: Prose status warns on elevated write-health

- **WHEN** `pipeline <issue> --status` runs for an issue whose latest run has elevated write-health
- **THEN** stdout SHALL include a human-readable warning about event-stream write failure

#### Scenario: Prose status stays quiet when healthy

- **WHEN** `pipeline <issue> --status` runs for an issue whose latest run has healthy or absent
  write-health
- **THEN** stdout SHALL NOT claim an event-stream write failure for that run

### Requirement: Status JSON SHALL emit a typed host-guidance signal for park and merge authority

The JSON object produced by `pipeline <issue> --status --json` SHALL include an additive closed-enum field that tells a host what it may do next without inferring authority from `next_action` prose. The field SHALL use a stable JSON key locked by implementation tests (intended name `host_guidance`). Allowed values SHALL be exactly:

- `continue` — the pipeline may proceed or the host may keep following; no operator disposition is required
- `recover-parked` — a residual park is present and the current park fingerprint is unspent; the host MAY invoke `pipeline recover-parked <N>` once
- `human-disposition-required` — the host MUST stop and request an exact operator-supplied disposition; the host MUST NOT invent a finding key or reason and MUST NOT invoke `pipeline override`
- `operator-merge` — the item is at `pipeline:ready-to-deploy`; merge remains an operator-authorized non-advance surface

The field is a host-guidance projection. It SHALL NOT become scheduler truth, SHALL NOT grant merge authority, and SHALL NOT create a second lifecycle controller. The envelope `schema_version` SHALL remain `"1"`. Every existing minimum status field SHALL remain present.

When the issue is in a `needs-human` stage or a residual review park (`blocked` and/or `needs-human` after review or pre-merge residual at the current head) and the current recover-parked fingerprint is unspent, the field SHALL be `recover-parked`. When that fingerprint is already spent, or the park is a true human-authority class (`human-decision-required`, missing authority, product judgment), the field SHALL be `human-disposition-required`. When spend state cannot be determined from issue evidence already available to status assembly, the field SHALL be `human-disposition-required` (fail closed). The field SHALL NEVER take a value that means the host may invent or execute `pipeline override`.

#### Scenario: Unspent residual park projects recover-parked

- **WHEN** `pipeline <issue> --status --json` runs for an issue in a residual review park at current HEAD
- **AND** no recover-parked spend marker covers the current park fingerprint
- **THEN** the typed host-guidance field SHALL equal `recover-parked`
- **AND** it SHALL NOT equal a value that authorizes `pipeline override`

#### Scenario: Spent fingerprint projects human-disposition-required

- **WHEN** `pipeline <issue> --status --json` runs for an issue that remains parked
- **AND** recover-parked spend evidence covers the current park fingerprint
- **THEN** the typed host-guidance field SHALL equal `human-disposition-required`
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Distinct later residual park in the same stage is unspent

- **WHEN** `pipeline <issue> --status --json` runs for an issue that remains in a residual review park at the same stage as an earlier recovered park
- **AND** a recover-parked spend marker covers the earlier park fingerprint
- **AND** the current park fingerprint is distinct and unspent
- **THEN** the typed host-guidance field SHALL equal `recover-parked`
- **AND** it SHALL NOT equal `human-disposition-required` solely because the earlier same-stage park was spent

#### Scenario: Unknown spend fails closed

- **WHEN** status assembly cannot determine whether the current park fingerprint is spent
- **THEN** the typed host-guidance field SHALL equal `human-disposition-required`
- **AND** it SHALL NOT equal `recover-parked`
- **AND** it SHALL NOT authorize override

#### Scenario: Ready-to-deploy projects operator-merge

- **WHEN** `pipeline <issue> --status --json` runs for an issue at stage `ready-to-deploy` that is not blocked
- **THEN** the typed host-guidance field SHALL equal `operator-merge`
- **AND** it SHALL NOT grant the host merge execution authority

#### Scenario: Additive field does not bump schema_version

- **WHEN** the status JSON envelope includes the typed host-guidance field
- **THEN** `schema_version` SHALL remain `"1"`
- **AND** every field in the existing minimum status set SHALL still be present

---

### Requirement: needs-human status next_action SHALL NOT instruct an autonomous override

The human-readable `next_action` string for a `needs-human` stage or residual review park SHALL identify recovery-first and human-disposition-required states. It SHALL NOT instruct an autonomous host to invoke `--override` or `pipeline override`. When host-guidance is `recover-parked`, the prose SHALL name `pipeline recover-parked` as the recovery-first action and SHALL state that a remaining park requires an exact human disposition. When host-guidance is `human-disposition-required`, the prose SHALL tell the host to stop and request an exact operator-supplied disposition. Mention of `pipeline override` in that prose, if present at all, SHALL be labeled as operator-supplied or explicitly approved and SHALL NOT be the autonomous next action.

The same recovery-first vs STOP split SHALL apply to prose `pipeline status` for a `needs-human` stage: the punch-list from `needsHumanPunchlist` and the ceiling-comment fallback SHALL consume the same fingerprint-aware host-guidance projection as JSON. Recovery-first text SHALL name `pipeline recover-parked <N>` only when host-guidance is `recover-parked`. When host-guidance is `human-disposition-required`, that punch-list or fallback SHALL omit the recover-parked instruction and SHALL tell the host to stop and request an exact operator-supplied disposition.

Existing `blocked` next_action text for non-park question/unblock paths MAY continue to name `pipeline unblock` when that is the typed-response surface for a recorded question. Residual review parks SHALL NOT treat generic `--unblock` or label removal as the host next action.

#### Scenario: needs-human next_action does not advertise autonomous override

- **WHEN** `deriveNextAction` (or the status assembler) produces `next_action` for stage `needs-human` with no blocked flag
- **THEN** the string SHALL NOT contain an instruction for the host to run `--override` or `pipeline override` as the next action
- **AND** the string SHALL identify that a human disposition is required after recovery

#### Scenario: recovery-first prose names recover-parked

- **WHEN** host-guidance is `recover-parked`
- **THEN** `next_action` SHALL name `pipeline recover-parked` as the recovery-first action
- **AND** SHALL state that if the issue remains parked the host stops and requests an exact human disposition

#### Scenario: human-disposition prose forbids invented override

- **WHEN** host-guidance is `human-disposition-required`
- **THEN** `next_action` SHALL tell the host to stop and request an exact operator-supplied disposition
- **AND** SHALL NOT present a synthesized finding key or reason as something the host may execute

#### Scenario: unit test fails if override returns as autonomous next action

- **WHEN** a unit test inspects `next_action` for `needs-human` and for a residual review park fixture
- **THEN** the test SHALL fail if the string matches an autonomous `--override` or `pipeline override` instruction of the pre-change form
- **AND** the test SHALL perform no real network, git, or subprocess calls

#### Scenario: spent fingerprint prose status omits recover-parked

- **WHEN** `pipeline status` runs in prose mode for a `needs-human` issue
- **AND** a ceiling comment is present so the punch-list is printed
- **AND** recover-parked spend evidence covers the current park fingerprint
- **THEN** the punch-list SHALL tell the host to stop and request an exact operator-supplied disposition
- **AND** it SHALL NOT instruct the host to run `pipeline recover-parked`

#### Scenario: unspent residual park prose status names recover-parked with the issue number

- **WHEN** `pipeline status` runs in prose mode for a `needs-human` issue
- **AND** host-guidance is `recover-parked`
- **THEN** the punch-list or fallback SHALL name `pipeline recover-parked <N>` with that issue's number
- **AND** SHALL state that a remaining park requires an exact human disposition
