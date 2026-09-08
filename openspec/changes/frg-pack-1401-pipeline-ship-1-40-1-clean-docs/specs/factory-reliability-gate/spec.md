## ADDED Requirements

### Requirement: The release 1.40.1 clean-docs pack item SHALL provide exact run-scoped regression artifacts

The release `1.40.1` `clean-docs` pack item SHALL provide, for pack run
`pack-1401-pipeline-ship-1.40.1`, a JSON fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` whose
`release_version` is exactly the string `1.40.1`, and an executable Node test at
`core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts`. The test SHALL read only that
exact fixture, parse it, and assert the literal release value. The change SHALL NOT alter
production behavior or files outside the declared run-scoped fixture, test, and active OpenSpec
change paths.

#### Scenario: Exact fixture and test pass for release 1.40.1

- **WHEN** the targeted Node test runs against the checked-in `clean-docs.json`
- **THEN** the fixture SHALL parse as JSON
- **AND** its `release_version` SHALL equal the string `1.40.1`
- **AND** the test SHALL pass without reading another run's fixture

#### Scenario: Changed release value is detected

- **WHEN** the exact fixture's `release_version` differs from `1.40.1`
- **THEN** the targeted Node test SHALL fail
- **AND** the failure SHALL NOT depend on network, git, subprocess, or production runtime behavior

#### Scenario: Full repository verification remains green

- **WHEN** the run-scoped fixture and test are complete
- **THEN** `npm run ci` from the repository root SHALL pass
- **AND** the implementation diff SHALL contain no production behavior change, foreign fixture,
  or foreign OpenSpec change

### Requirement: The release 1.40.1 clean-docs pack item SHALL preserve ordinary controller-owned lifecycle evidence

The release `1.40.1` `clean-docs` item SHALL traverse normal issue-readiness admission, planning,
plan review, implementation, and review without an issue-number, label-only, or reduced-rigor
bypass. If OpenSpec planning is used, pre-merge SHALL archive this issue's change without leaving
a foreign active change. The Pipeline SHALL reach `pipeline:ready-to-deploy` without merging or
deploying, and after the FRG records the run, the FRG controller SHALL close the pull request and
issue without merge. These later archive, ready-to-deploy, and cleanup facts SHALL remain
controller-owned lifecycle evidence and SHALL NOT appear as unchecked implementer tasks or be
claimed before they occur.

#### Scenario: Fixture traverses ordinary review lifecycle

- **WHEN** Pipeline advances issue `#1553`
- **THEN** the issue SHALL receive normal issue-readiness admission, planning, plan review,
  implementation, and review
- **AND** fixture identity or factory-gate labels SHALL NOT bypass or reduce those stages

#### Scenario: Pre-merge archives only this issue's change

- **WHEN** implementation and pre-archive verification are complete and pre-merge processes the
  active OpenSpec change
- **THEN** pre-merge SHALL archive `frg-pack-1401-pipeline-ship-1-40-1-clean-docs`
- **AND** it SHALL leave no foreign active OpenSpec change
- **AND** the archive observation SHALL NOT be required as an unchecked pre-archive task

#### Scenario: Advance stops ready without merge or deployment

- **WHEN** the ordinary Pipeline lifecycle completes successfully for issue `#1553`
- **THEN** it SHALL reach `pipeline:ready-to-deploy`
- **AND** advance SHALL NOT merge or deploy the pull request
- **AND** ready-to-deploy SHALL remain controller-owned evidence rather than a pre-archive
  implementation task

#### Scenario: FRG closes recorded synthetic artifacts without merge

- **WHEN** the FRG controller records the completed pack run
- **THEN** it SHALL close the pull request and issue without merge
- **AND** that cleanup SHALL remain controller-owned evidence rather than a pre-archive
  implementation task
