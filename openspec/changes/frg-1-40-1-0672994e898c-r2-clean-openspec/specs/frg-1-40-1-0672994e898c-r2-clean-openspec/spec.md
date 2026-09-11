## Purpose

Records the synthetic clean OpenSpec fixture for factory-gate pack run `frg-1.40.1-0672994e898c-r2` on release `1.40.1`, including the controller-owned lifecycle evidence that must not become implementer tasks.

## ADDED Requirements

### Requirement: The run-scoped clean-openspec fixture SHALL name release 1.40.1

The JSON fixture at `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-openspec.json` SHALL set `release_version` to the literal string `1.40.1`. The executable Node unit test at `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-openspec.test.ts` SHALL read only that fixture, parse it, and assert that literal value. The test SHALL fail when the fixture's `release_version` value changes. The OpenSpec change `frg-1-40-1-0672994e898c-r2-clean-openspec` SHALL belong only to issue #1587. The product diff SHALL stay inside that fixture path, that test path, and this OpenSpec change.

#### Scenario: Fixture names the exact release

- **WHEN** the run-scoped JSON fixture is read
- **THEN** its `release_version` field SHALL equal the literal string `1.40.1`

#### Scenario: Unit test binds only that fixture to the literal release

- **WHEN** `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-openspec.test.ts` runs against the committed fixture
- **THEN** the test SHALL read only `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-openspec.json`
- **AND** SHALL parse that file
- **AND** SHALL pass because the parsed `release_version` equals `1.40.1`

#### Scenario: Changed release value fails the test

- **WHEN** the fixture's `release_version` value is not the literal string `1.40.1`
- **AND** the same unit test runs
- **THEN** the test SHALL fail

#### Scenario: Foreign files stay out of the product diff

- **WHEN** this change is implemented
- **THEN** the product diff SHALL NOT edit production behavior, classifiers, recovery recipes, gates, or controllers
- **AND** SHALL NOT edit another run's fixtures or another issue's OpenSpec change

### Requirement: Controller-owned lifecycle evidence SHALL remain required outside implementer tasks

The change SHALL keep controller-owned lifecycle observations in requirements and scenarios. `tasks.md` SHALL contain only implementer-owned fixture, test, and pre-archive verification work that can finish before pre-merge archive. Those future observations SHALL remain required acceptance evidence. They SHALL NOT be copied into `tasks.md`, silently checked, discarded, or treated as evidence before they occur. The living-spec archive destination SHALL be `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-openspec/spec.md` only.

#### Scenario: Ordinary pipeline rigor is not bypassed

- **WHEN** issue #1587 is admitted and advanced
- **THEN** the issue SHALL receive ordinary issue-readiness admission, planning, plan review, implementation, and review
- **AND** the fixture SHALL NOT receive a label-only bypass or reduced rigor

#### Scenario: Pre-merge archives only this change

- **WHEN** pre-merge archives OpenSpec state for this issue
- **THEN** pre-merge SHALL archive this issue's OpenSpec change `frg-1-40-1-0672994e898c-r2-clean-openspec`
- **AND** SHALL leave no foreign active change
- **AND** the living spec SHALL land at `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-openspec/spec.md`

#### Scenario: Ready-to-deploy does not merge or deploy

- **WHEN** the full Pipeline reaches `pipeline:ready-to-deploy` for this issue
- **THEN** advance SHALL NOT merge
- **AND** advance SHALL NOT deploy

#### Scenario: FRG controller closes without merge

- **WHEN** the FRG records the run after ready-to-deploy
- **THEN** the FRG controller SHALL close the pull request and issue without merge

#### Scenario: Implementer checklist excludes future observations

- **WHEN** `tasks.md` is read before pre-merge archive
- **THEN** it SHALL list only implementer-owned fixture creation, executable-test creation, and pre-archive verification
- **AND** it SHALL NOT list archive, ready-to-deploy, merge, deployment, or post-recording close as unchecked implementation tasks
