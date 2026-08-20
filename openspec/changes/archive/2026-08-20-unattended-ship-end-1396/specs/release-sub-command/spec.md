## ADDED Requirements

### Requirement: release ensure-tag SHALL observe owner-name from the git remote when cfg.repo is empty

`pipeline release ensure-tag` SHALL re-observe the merged release PR using `owner/name` from the git origin remote in `repoDir` when `resolveReleaseConfig` returns `repo` as the empty string. Observe SHALL fail closed only when neither config nor a parseable origin remote supplies `owner/name`. Ensure-tag SHALL honor `--repo-path` as the repository working tree.

#### Scenario: Empty cfg.repo with origin remote observes the PR

- **WHEN** `resolveReleaseConfig` returns `repo: ""`
- **AND** `git remote get-url origin` in `repoDir` is `git@github.com:accidental-hedge-fund/agent-pipeline.git`
- **THEN** ensure-tag SHALL observe the release PR in `accidental-hedge-fund/agent-pipeline`
- **AND** it SHALL NOT throw `cannot re-observe the release PR without a repository`
