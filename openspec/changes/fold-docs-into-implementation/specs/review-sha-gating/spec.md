## ADDED Requirements

### Requirement: Pipeline-internal commit exemption covers only OpenSpec archive commits
When the SHA gate detects that HEAD has moved past the reviewed commit, it SHALL classify commits since the review as either "pipeline-internal" or "developer/fix". A commit is pipeline-internal if and only if its message headline starts with the OpenSpec archive prefix (`chore: archive OpenSpec change(s) for #`). If every commit since the review is pipeline-internal, the prior verdict SHALL remain valid. A docs-update commit (`docs: update documentation for #`) SHALL NOT be treated as pipeline-internal, because the pre-merge docs step no longer exists and no such commits are produced by the pipeline.

#### Scenario: Only OpenSpec archive commits since review — verdict valid
- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review has the message prefix `chore: archive OpenSpec change(s) for #`
- **THEN** the SHA gate SHALL treat the prior verdict as valid and SHALL NOT trigger a re-review

#### Scenario: A docs-prefix commit present — treated as developer commit
- **WHEN** a commit with message prefix `docs: update documentation for #` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL trigger re-review as if HEAD had moved past the reviewed SHA

#### Scenario: Mix of archive and developer commits — re-review required
- **WHEN** commits since the review include at least one commit that is not an OpenSpec archive commit
- **THEN** the SHA gate SHALL discard the prior verdict and re-run review
