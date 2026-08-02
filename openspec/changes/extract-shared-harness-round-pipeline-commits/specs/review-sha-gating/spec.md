## MODIFIED Requirements

### Requirement: Pipeline-internal commit exemption uses the neutral classifier set

When the SHA gate detects that HEAD has moved past the reviewed commit, it SHALL classify commits since the review as either "pipeline-internal" or "developer/fix" using `isPipelineInternalCommit` from the neutral pipeline-commits module. A commit is pipeline-internal if and only if that classifier returns true for its message headline: the OpenSpec archive prefix (`chore: archive OpenSpec change(s) for #…`) or the exact visual-gate artifact-publish subject (`chore: publish visual-gate evidence for #<digits>` with no trailing text). If every commit since the review is pipeline-internal, the prior verdict SHALL remain valid without any further checks for the internal-commit exemption path. A docs-update commit (`docs: update documentation for #`) SHALL NOT be treated as pipeline-internal. An auto-format commit (`chore: auto-format (#…`) SHALL NOT be treated as pipeline-internal. A pre-merge auto-fix commit SHALL NOT be treated as pipeline-internal. When non-pipeline-internal commits are present, the gate SHALL continue to the diff-hash cache check (not immediately trigger a review stage re-run).

#### Scenario: Only OpenSpec archive commits since review — verdict valid

- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review has the message prefix `chore: archive OpenSpec change(s) for #`
- **THEN** the SHA gate SHALL treat the prior verdict as valid for the internal-commit exemption and SHALL NOT trigger a re-review or diff-hash check solely because those archive commits landed

#### Scenario: Only exact visual-publish commits since review — verdict valid

- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review is an exact visual-gate artifact-publish subject
- **THEN** the SHA gate SHALL treat the prior verdict as valid for the internal-commit exemption
- **AND** SHALL NOT invalidate the verdict solely because those publish commits landed

#### Scenario: A docs-prefix commit present — treated as developer commit

- **WHEN** a commit with message prefix `docs: update documentation for #` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL proceed to the diff-hash cache check (not immediately trigger re-review)

#### Scenario: An auto-format commit present — treated as developer commit

- **WHEN** a commit with message beginning `chore: auto-format (#` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL proceed to the diff-hash cache check

#### Scenario: Mix of archive and developer commits — diff-hash check required

- **WHEN** commits since the review include at least one commit that is not pipeline-internal under the neutral classifier
- **THEN** the SHA gate SHALL NOT immediately trigger a full review re-run
- **AND** SHALL proceed to the diff-hash cache check; if the diff hash is unchanged, the verdict is reused; if the diff hash changed, a delta review runs
