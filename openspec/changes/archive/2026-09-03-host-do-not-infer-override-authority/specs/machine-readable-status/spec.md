## ADDED Requirements

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
