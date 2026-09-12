## Purpose

This capability is the run-scoped clean-openspec fixture for pack run
`frg-1.40.1-c9433f3fd39b`. It names Pipeline release `1.40.1` and records the
ordinary OpenSpec lifecycle that the FRG controller observes.

## ADDED Requirements

### Requirement: The run-scoped clean-openspec fixture SHALL name release 1.40.1

The run-scoped clean-openspec fixture SHALL name release `1.40.1`. The JSON
file at `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json`
SHALL contain `release_version` exactly `1.40.1`. The executable Node unit
test at `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts` SHALL
read only that fixture, parse it, and assert the literal release value. The
test SHALL fail when that value is not `1.40.1`. This OpenSpec change SHALL
belong only to issue #1601. Production behavior, another run's fixtures, and
another issue's OpenSpec change SHALL remain unchanged.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the JSON fixture at
  `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json` is parsed
- **THEN** its `release_version` SHALL equal the literal string `1.40.1`

#### Scenario: Unit test fails when the release value changes

- **WHEN** the fixture `release_version` is not `1.40.1`
- **AND** the unit test at
  `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts` runs
- **THEN** the test SHALL fail

#### Scenario: Unit test reads only the run-scoped fixture

- **WHEN** the unit test runs
- **THEN** it SHALL read only
  `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json`
- **AND** it SHALL parse that file and assert the literal release value
  `1.40.1`

#### Scenario: Change stays inside this issue's run-scoped paths

- **WHEN** this fixture is implemented
- **THEN** the product diff SHALL stay inside
  `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json`,
  `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts`, and
  `openspec/changes/frg-1-40-1-c9433f3fd39b-clean-openspec/`
- **AND** production classifiers, recovery recipes, gates, and controllers
  SHALL remain unchanged

### Requirement: This fixture's OpenSpec lifecycle SHALL remain controller-owned evidence

This fixture's OpenSpec lifecycle SHALL remain controller-owned evidence.
Ordinary issue-readiness admission, planning, plan review, implementation,
and review SHALL run with no label-only bypass or reduced rigor. Pre-merge
SHALL archive this issue's OpenSpec change and SHALL leave no foreign active
change. The living spec SHALL land only at
`openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`. The pipeline
SHALL reach `pipeline:ready-to-deploy` and SHALL NOT merge or deploy during
advance. After the FRG records the run, the FRG controller SHALL close the
pull request and issue without merge. These observations SHALL NOT appear as
implementer checklist items in `tasks.md`.

#### Scenario: Ordinary pipeline rigor is not bypassed

- **WHEN** this fixture issue enters the pipeline
- **THEN** it SHALL receive ordinary issue-readiness admission, planning,
  plan review, implementation, and review
- **AND** it SHALL NOT receive a label-only bypass or reduced rigor

#### Scenario: Pre-merge archives only this issue's change

- **WHEN** pre-merge archives OpenSpec changes for this issue
- **THEN** it SHALL archive `frg-1-40-1-c9433f3fd39b-clean-openspec`
- **AND** it SHALL leave no foreign active change
- **AND** the living spec SHALL exist only at
  `openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`

#### Scenario: Advance stops at ready-to-deploy without merge

- **WHEN** the full pipeline completes this fixture
- **THEN** the issue SHALL reach `pipeline:ready-to-deploy`
- **AND** advance SHALL NOT merge or deploy

#### Scenario: FRG controller closes without merge

- **WHEN** the FRG has recorded the run
- **THEN** the FRG controller SHALL close the pull request and issue
- **AND** that close SHALL NOT merge the pull request

#### Scenario: Controller observations stay out of tasks.md

- **WHEN** implementer-owned `tasks.md` is written for this change
- **THEN** it SHALL contain only work and verification that can finish
  before pre-merge archive
- **AND** it SHALL NOT list archive, ready-to-deploy, merge, deploy, or
  post-recording close as checklist items
