# needs-human-status-surface Specification

## Purpose
TBD - created by archiving change status-needs-human-punchlist. Update Purpose after archive.
## Requirements
### Requirement: --status on needs-human prints the punch-list
When `--status` is invoked on an issue whose resolved stage is `needs-human`, the output SHALL include the unresolved blocking-finding count and the resume steps, in addition to the bare stage line already printed for all stages. The count and resume steps SHALL be derived from the latest `## Pipeline: Review ceiling reached` comment on the issue. If no such comment exists, the output SHALL include a graceful fallback line noting the ceiling comment was not found.

#### Scenario: needs-human with a ceiling comment
- **WHEN** `--status` is called on an issue at stage `needs-human`
- **AND** the issue has a comment starting with `## Pipeline: Review ceiling reached`
- **THEN** the output SHALL include a line with the count of unresolved blocking findings from that comment
- **AND** the output SHALL include the resume hint: use `--override "<key>: <reason>"` or fix by hand, then relabel `pipeline:needs-human` → `pipeline:review-2`

#### Scenario: needs-human with no ceiling comment
- **WHEN** `--status` is called on an issue at stage `needs-human`
- **AND** no comment on the issue starts with `## Pipeline: Review ceiling reached`
- **THEN** the output SHALL include a graceful fallback line (e.g. "ceiling comment not found")
- **AND** SHALL NOT throw or exit non-zero

#### Scenario: non-needs-human stage is unchanged
- **WHEN** `--status` is called on an issue at any stage other than `needs-human`
- **THEN** the output SHALL be identical to the pre-change output for that stage
- **AND** no ceiling comment SHALL be parsed or printed

### Requirement: Pure helper parses ceiling comment
The blocking-finding count and resume steps SHALL be extracted by a pure helper function `needsHumanPunchlist(comments: IssueComment[]) => string | null`. The helper SHALL be a total function: given any comment list, it returns a formatted string when a ceiling comment is found, or `null` when none is found. The helper SHALL NOT perform any network, git, or subprocess calls.

#### Scenario: helper finds ceiling comment
- **WHEN** `needsHumanPunchlist` is called with a comment list containing a comment whose body starts with `## Pipeline: Review ceiling reached`
- **THEN** it SHALL return a string containing the unresolved finding count derived from that comment
- **AND** the string SHALL contain the resume hint

#### Scenario: helper finds no ceiling comment
- **WHEN** `needsHumanPunchlist` is called with a comment list containing no comment starting with `## Pipeline: Review ceiling reached`
- **THEN** it SHALL return `null`

#### Scenario: helper uses the latest ceiling comment
- **WHEN** multiple comments start with `## Pipeline: Review ceiling reached`
- **THEN** the helper SHALL use the last such comment (highest index) as the authoritative source

