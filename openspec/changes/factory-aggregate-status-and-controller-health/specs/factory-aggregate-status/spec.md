## ADDED Requirements

### Requirement: `pipeline factory status --json` SHALL write exactly one unfenced versioned JSON object

The pipeline CLI SHALL provide a factory-level status command invocable as
`pipeline factory status` (or an equivalent registry-routed factory status keyword that
preserves the same semantics). When `--json` is supplied, the command SHALL write exactly one
JSON object to stdout with no surrounding markdown fence, no leading prose, and no trailing
non-JSON bytes. The object SHALL include a `schema_version` string (initially `"1"`) and a
top-level `status` discriminant whose values include at least `ok`, `degraded`, and `error`.
Structured failures and partial source failures SHALL still yield valid JSON parseable by
`JSON.parse(stdout)`.

#### Scenario: JSON mode emits a single parseable object

- **WHEN** `pipeline factory status --json` is invoked against an injectable status assembler
- **THEN** stdout SHALL contain exactly one JSON object with no code fences or prose
- **AND** `JSON.parse(stdout)` SHALL succeed
- **AND** the object SHALL include `schema_version` and `status`

#### Scenario: Error state remains valid JSON

- **WHEN** the assembler cannot read any required factory status source and classifies the
  outcome as error
- **THEN** stdout SHALL still be a valid JSON object
- **AND** `status` SHALL equal `"error"`
- **AND** the object SHALL include a sanitized `error` string field
- **AND** the command SHALL exit non-zero

#### Scenario: Degraded state when optional sources fail

- **WHEN** the primary run projection is readable but an optional source (for example cost or
  write-health) fails to load
- **THEN** `status` SHALL be `"degraded"` or `"ok"` with explicit per-source unknown/failure
  attribution
- **AND** stdout SHALL remain a single valid JSON object

#### Scenario: Human mode without `--json` is non-JSON prose

- **WHEN** `pipeline factory status` is invoked without `--json`
- **THEN** stdout SHALL be human-readable prose derived from the same allowlisted model
- **AND** SHALL NOT be required to be valid JSON

---

### Requirement: Factory status SHALL perform no mutating side effects

Producing factory status SHALL perform no GitHub mutation, no git mutation, no service or
control mutation, no ledger write, no event append, no lock acquisition that changes
ownership, and no run-artifact create/modify/delete. Unit tests SHALL exercise the assembler
and CLI handler through injected seams and record zero write/mutate calls.

#### Scenario: Status records zero mutations through injected seams

- **WHEN** factory status runs with injected GitHub, git, store, service, and filesystem seams
- **THEN** those seams SHALL record zero mutating calls
- **AND** no ledger, event, lock-token, or run-artifact write SHALL occur

#### Scenario: Status of a locked run does not require or steal the lock

- **WHEN** factory status is requested for a run whose lock is held by another process
- **THEN** status SHALL be produced without acquiring the holder token
- **AND** the lock record SHALL remain unchanged

---

### Requirement: The factory status snapshot SHALL include the minimum allowlisted field set

The versioned JSON snapshot SHALL include, either as concrete values or as explicit
unknown/legacy/not-applicable attribution, the following categories:

- controller and/or service identity
- controller mode and revision (when a macro-controller or equivalent is present)
- active contract and/or durable run identity
- engine, treatment, and authority fingerprints when recorded
- counts of active, queued, and held items
- per-item coarse state and stage projection when recorded
- linked advance run id, PR identity, and candidate/track identity when recorded
- current operation and its deadline when recorded
- last durable progress timestamp or equivalent marker
- expected wait kind and deadline when recorded
- provider cooldown when recorded
- next action as a coarse allowlisted summary or code (not unsanitized free text)
- lock/liveness projection (allowlisted summary only; never raw tokens)
- event-stream or write-health summary when recorded
- cost coverage as actual, estimated, or unknown (never invented zero or quota percent)

Additive optional fields within the same `schema_version` SHALL be permitted when they remain
allowlisted and unknown-safe.

#### Scenario: Minimum categories present on a fully instrumented factory

- **WHEN** factory status is assembled from complete controller, loop, pin, provider, and
  write-health fakes
- **THEN** the JSON object SHALL include every minimum category above as a non-null structured
  value or nested object
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Missing optional sources become explicit unknown

- **WHEN** factory status is assembled without cost telemetry and without a macro-controller
  record
- **THEN** cost coverage SHALL be marked unknown
- **AND** controller mode/revision SHALL be marked unknown, legacy, or not_applicable
- **AND** the command SHALL still emit a valid snapshot rather than failing solely for those
  absences

#### Scenario: Legacy run without operation deadlines remains readable

- **WHEN** status is assembled for a legacy run that lacks current-operation deadline fields
- **THEN** the snapshot SHALL remain valid JSON
- **AND** operation/deadline fields SHALL carry explicit unknown or legacy attribution
- **AND** the assembler SHALL NOT invent deadlines

---

### Requirement: Remote factory status output SHALL be assembled only from an explicit allowlist

The public JSON object and the human rendering derived from it SHALL include only fields on an
explicit output allowlist. The following MUST NEVER appear in JSON, human prose, or error
output:

- raw lock or supervisor records
- lock bearer tokens or supervisor bearer tokens
- credentials, secret values, or secret references
- process environment maps
- prompts, tool transcripts, or raw model/worker output
- local auth material
- unsanitized issue titles, comment bodies, hold reasons, or other free-text instruction-like
  payloads copied from source objects

Free-text sources SHALL be dropped, replaced with coarse enums/codes, or reduced to a short
allowlisted summary that cannot carry secrets or prompt payloads.

#### Scenario: Allowlist drops raw lock token fields

- **WHEN** the underlying process or lock record contains a lock token or bearer field
- **AND** factory status is assembled
- **THEN** the public JSON and human output SHALL NOT contain that token value or the raw
  record dump

#### Scenario: Unsanitized hold reason does not pass through

- **WHEN** a ledger or audit source contains a free-text hold reason
- **AND** factory status is assembled
- **THEN** the public output SHALL NOT include the raw reason string
- **AND** MAY include a coarse hold/wait code or truncated allowlisted summary only

---

### Requirement: Factory status sanitization SHALL be proven with canary injection tests

Unit tests SHALL inject distinctive canary secret strings and prompt-like issue/reason text into
every registered status source object and SHALL assert that no canary string and no raw
prompt/instruction payload appears in the JSON serialization, the human-readable rendering, or
error-path output. Adding a new source object type without covering it in the canary suite
SHALL fail the guard.

#### Scenario: Canary secret in every source is stripped

- **WHEN** each status source object is seeded with a unique canary secret string
- **AND** factory status JSON and human output are produced
- **THEN** neither stdout form nor error output SHALL contain any of those canary strings

#### Scenario: Prompt-like free text in issue or reason fields is stripped

- **WHEN** a source object includes prompt-like text in an issue title, comment, or reason field
- **AND** factory status is produced
- **THEN** the public output SHALL NOT contain that raw prompt-like text

---

### Requirement: Missing telemetry and cost SHALL remain unknown without inference

When cost or telemetry data is absent, unreadable, or incomplete, factory status SHALL report
coverage as unknown (or partial with unknown components). The assembler SHALL NOT emit a
remaining-quota percentage and SHALL NOT invent a zero cost, zero token count, or other numeric
success metric solely from absence of data.

#### Scenario: Absent cost data is unknown not zero

- **WHEN** no cost accounting artifact is available for the active run
- **THEN** cost coverage SHALL be `unknown` (or equivalent)
- **AND** the snapshot SHALL NOT report `cost_usd: 0` as if measured

#### Scenario: No remaining-quota percentage from missing telemetry

- **WHEN** provider telemetry does not include remaining quota
- **THEN** the snapshot SHALL NOT invent a remaining-quota percentage field from absence

---

### Requirement: Factory status assembly SHALL be unit-tested with injected seams only

The status assembler and classification helpers SHALL be exercisable with injected clocks,
process probes, stores, controller/service readers, pin readers, provider readers, and
write-health readers. Unit tests SHALL perform no real network, git, or subprocess calls.

#### Scenario: Injected clock freezes generated_at

- **WHEN** a unit test injects a clock that returns a fixed instant
- **AND** assembles factory status
- **THEN** `generated_at` SHALL equal that instant's ISO-8601 representation

#### Scenario: No real I/O in unit tests

- **WHEN** the factory status unit test suite runs
- **THEN** it SHALL not open real GitHub, git, or subprocess channels
- **AND** all external effects SHALL go through fakes
