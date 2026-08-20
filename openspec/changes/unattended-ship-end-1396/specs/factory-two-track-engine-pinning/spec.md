## ADDED Requirements

### Requirement: Non-skip engine-promote SHALL write peeled tag git_sha

Non-skip `pipeline engine-promote` SHALL set production pin `git_sha` to the peeled annotated tag commit (40-hex) for `vX.Y.Z`. It SHALL NOT write `git_sha` null. Packed HMAC `candidate_git_sha` MAY be an ancestor of that peel when the release squash is a version bump only. Promote SHALL fail closed when the peel is missing, when packed SHA is not the peel and is not an ancestor of the peel, or when `latest.json` `pass` is not true for the release version.

#### Scenario: Peel is written when packed SHA differs from merge

- **WHEN** HMAC packed `candidate_git_sha` is `6df3f18f…`
- **AND** the annotated tag `v1.39.5` peels to `1a027ef2…`
- **AND** packed SHA is an ancestor of the peel
- **AND** `latest.json` `pass` is true for `1.39.5`
- **THEN** the production pin SHALL write `git_sha` equal to the 40-hex peel
- **AND** it SHALL NOT write `git_sha` null

#### Scenario: Packed not ancestor of peel refuses promote

- **WHEN** packed HMAC SHA is not an ancestor of the peeled tag
- **THEN** non-skip engine-promote SHALL refuse
- **AND** the existing pin file SHALL remain unchanged

#### Scenario: Missing peel refuses promote

- **WHEN** annotated tag `vX.Y.Z` cannot be peeled to a 40-hex commit
- **THEN** non-skip engine-promote SHALL refuse
- **AND** it SHALL NOT write `git_sha` null

#### Scenario: Explicit packed gitSha does not replace peel

- **WHEN** non-skip engine-promote is given an explicit `gitSha` equal to packed HMAC `candidate_git_sha`
- **AND** that packed SHA is an ancestor of peeled `vX.Y.Z^{commit}`
- **AND** `latest.json` `pass` is true
- **THEN** the production pin SHALL write `git_sha` equal to the peeled tag commit
- **AND** it SHALL NOT write the packed ancestor
- **AND** it SHALL still resolve `${tag}^{commit}` rather than treating `gitSha` as the peel
