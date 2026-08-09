## ADDED Requirements

### Requirement: Train merge mode SHALL not treat ready-to-deploy as dependency satisfaction

When an integrated train runs with `--merge`, a same-train prerequisite that has only reached `pipeline:ready-to-deploy` SHALL NOT satisfy a dependent's in-train dependency. The dependent SHALL become eligible only after the train records verified integration evidence for the prerequisite: the linked pull request is merged through the Pipeline merge surface and the merge-result commit is contained in a freshly fetched configured base.

#### Scenario: Ready prerequisite does not release a dependent in merge train

- **WHEN** prerequisite A is at `pipeline:ready-to-deploy` with an open PR during a merge train that also contains dependent B
- **THEN** B SHALL NOT start
- **AND** the train's next action for A SHALL be merge (or wait on merge gates), not start B

#### Scenario: Contained merge releases the dependent

- **WHEN** prerequisite A has a merge-result commit contained in the fetched base under a merge train
- **THEN** dependent B MAY start subject to other scheduling rules
- **AND** train status SHALL show A as integrated
