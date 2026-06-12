## MODIFIED Requirements

### Requirement: Pure helper parses ceiling comment
The blocking-finding count and resume steps SHALL be extracted by a pure helper function `needsHumanPunchlist(comments: IssueComment[]) => string | null`. The helper SHALL be a total function: given any comment list, it returns a formatted string when a ceiling comment (or recurrence-triggered punch-list comment) is found, or `null` when none is found. The helper SHALL NOT perform any network, git, or subprocess calls. The formatted string SHALL tag each finding listed in the punch-list as `RECURRING (n rounds)` or `NEW`, where `n` is derived from prior Review-N comment bodies in the same comment list (by set-membership of the finding's `findingKey`). If a finding line contains no parseable key, it SHALL be tagged `NEW` by default.

#### Scenario: helper finds ceiling comment
- **WHEN** `needsHumanPunchlist` is called with a comment list containing a comment whose body starts with `## Pipeline: Review ceiling reached`
- **THEN** it SHALL return a string containing the unresolved finding count derived from that comment
- **AND** the string SHALL contain the resume hint
- **AND** each finding line SHALL include a `RECURRING (n rounds)` or `NEW` tag

#### Scenario: helper finds recurrence-triggered punch-list comment
- **WHEN** `needsHumanPunchlist` is called with a comment list containing a recurrence-triggered punch-list comment (same `## Pipeline: Review ceiling reached` header, posted before the round budget is exhausted)
- **THEN** it SHALL return a string containing the unresolved finding count and tags, identical in structure to the ceiling-triggered case

#### Scenario: helper finds no ceiling comment
- **WHEN** `needsHumanPunchlist` is called with a comment list containing no comment starting with `## Pipeline: Review ceiling reached`
- **THEN** it SHALL return `null`

#### Scenario: helper uses the latest ceiling comment
- **WHEN** multiple comments start with `## Pipeline: Review ceiling reached`
- **THEN** the helper SHALL use the last such comment (highest index) as the authoritative source

#### Scenario: finding line with no parseable key — tagged NEW
- **WHEN** `needsHumanPunchlist` encounters a finding line in the punch-list comment that contains no 8-character hex key matching the override-key pattern
- **THEN** that finding SHALL be tagged `NEW` by default
